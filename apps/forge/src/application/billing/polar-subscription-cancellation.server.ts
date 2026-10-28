import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import { verifiedPolarSubscriptionSnapshot } from "./polar-subscription-reconciliation.server"
import { applyVerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { Actor } from "@/application/actor"
import type { Polar } from "@polar-sh/sdk/2026-10"

export type CancellationContext = {
  workspaceId: string
  subscriptionId: string
}
type CancellationClient = {
  subscriptions: {
    get: (id: string) => Promise<ProviderSubscription>
    update: (
      id: string,
      input: Parameters<Polar["subscriptions"]["update"]>[1]
    ) => Promise<ProviderSubscription>
  }
}

/** The only provider write schedules the end; no immediate revoke/refund API is used. */
export class PolarSubscriptionCancellation {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly resolveContext: (
      actor: Actor
    ) => Promise<CancellationContext>,
    private readonly client: CancellationClient = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }),
    private readonly apply: typeof applyVerifiedSubscriptionSnapshot = applyVerifiedSubscriptionSnapshot
  ) {}

  async schedule(actor: Actor) {
    const identity = workspaceBillingIdentity(actor)
    const context = await this.resolveContext(actor)
    if (context.workspaceId !== identity.workspaceId)
      throw new Error("BILLING_ACTOR_WORKSPACE_MISMATCH")
    const id = z.uuid().parse(context.subscriptionId)
    let current = await this.client.subscriptions.get(id)
    const before = verifiedPolarSubscriptionSnapshot(
      this.config,
      context.workspaceId,
      id,
      current
    )
    // Revalidate live roles/binding after the network read, immediately before effects.
    const fresh = await this.resolveContext(actor)
    if (
      fresh.workspaceId !== context.workspaceId ||
      fresh.subscriptionId !== id
    )
      throw new Error("BILLING_SUBSCRIPTION_CONFLICT")
    if (!before.cancelAtPeriodEnd && !before.terminatedAt) {
      await this.client.subscriptions.update(id, { cancel_at_period_end: true })
      current = await this.client.subscriptions.get(id)
    }
    const snapshot = verifiedPolarSubscriptionSnapshot(
      this.config,
      context.workspaceId,
      id,
      current
    )
    if (
      !snapshot.terminatedAt &&
      (!snapshot.cancelAtPeriodEnd ||
        snapshot.currentPeriodEnd.getTime() !==
          before.currentPeriodEnd.getTime())
    )
      throw new Error("BILLING_CANCELLATION_NOT_CONFIRMED")
    const eventId = `forge.cancel.${id}.${snapshot.updatedAt.toISOString()}`
    const bodyHash = createHash("sha256")
      .update(
        JSON.stringify({
          operation: "cancel-at-period-end",
          workspaceId: context.workspaceId,
          subscriptionId: id,
          periodEnd: snapshot.currentPeriodEnd.toISOString(),
        })
      )
      .digest("hex")
    const result = await this.apply({ eventId, bodyHash, snapshot, actor })
    if (result.outcome === "stale")
      throw new Error("BILLING_CANCELLATION_RECONCILIATION_REQUIRED")
    return {
      status:
        snapshot.status === "canceled"
          ? ("canceled" as const)
          : ("scheduled" as const),
      cancellationEffectiveAt: (
        snapshot.terminatedAt ?? snapshot.currentPeriodEnd
      ).toISOString(),
    }
  }
}
