import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { billableMemberCountSchema } from "./billing-plan-contract"
import { verifiedPolarSubscriptionSnapshot } from "./polar-subscription-reconciliation.server"
import { applyVerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type {
  RefundRenewalIdentity,
  confirmUpgradeRefundRenewal,
  readUpgradeRefundRenewalContext,
} from "./upgrade-refund-renewal-context.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { PlanChangeSubscription } from "./polar-plan-change.server"
import type { Polar } from "@polar-sh/sdk/2026-10"

export type RefundRenewalClient = {
  get: (id: string) => Promise<PlanChangeSubscription>
  update: (
    id: string,
    body: Parameters<Polar["subscriptions"]["update"]>[1]
  ) => Promise<PlanChangeSubscription>
}
type Store = {
  read: typeof readUpgradeRefundRenewalContext
  confirm: typeof confirmUpgradeRefundRenewal
  project: typeof applyVerifiedSubscriptionSnapshot
}

/** Only schedules the product. No invoice, credit, seat, period, cancellation or trial mutation. */
export class PolarUpgradeRefundRenewal {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly client: RefundRenewalClient = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }).subscriptions,
    private readonly store: Store = {
      read: async (input) =>
        (
          await import("./upgrade-refund-renewal-context.server")
        ).readUpgradeRefundRenewalContext(input),
      confirm: async (input, proof) =>
        (
          await import("./upgrade-refund-renewal-context.server")
        ).confirmUpgradeRefundRenewal(input, proof),
      project: applyVerifiedSubscriptionSnapshot,
    },
    private readonly clock: () => Date = () => new Date()
  ) {}

  async reconcile(input: RefundRenewalIdentity) {
    if (input.environment !== this.config.environment)
      throw new Error("BILLING_REFUND_ENVIRONMENT_CONFLICT")
    const id = z.uuid().parse(input.subscriptionId)
    const context = await this.store.read(input)
    if (context.status !== "required")
      return { status: context.status, replayed: false }
    const observe = async () => {
      const value = await this.client.get(id)
      const snapshot = verifiedPolarSubscriptionSnapshot(
        this.config,
        input.workspaceId,
        id,
        value
      )
      if (snapshot.terminatedAt || snapshot.unsupportedPauseAt) {
        const eventId = `forge.refund-renewal.restricted.${id}.${snapshot.updatedAt.toISOString()}`
        await this.store.project({
          eventId,
          bodyHash: createHash("sha256").update(eventId).digest("hex"),
          snapshot,
        })
        if (snapshot.unsupportedPauseAt && !snapshot.terminatedAt)
          throw new Error("BILLING_SUBSCRIPTION_PAUSE_UNSUPPORTED")
        return { value, snapshot, terminal: true as const }
      }
      if (
        snapshot.currentPeriodStart.toISOString() !== context.start ||
        snapshot.currentPeriodEnd.toISOString() !== context.end ||
        this.clock().getTime() >= snapshot.currentPeriodEnd.getTime()
      )
        throw new Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT")
      if (
        (value.status !== "active" && value.status !== "past_due") ||
        value.cancel_at_period_end ||
        value.pause_at_period_end ||
        value.paused_at !== null ||
        value.ends_at !== null ||
        value.ended_at !== null
      )
        throw new Error("BILLING_REFUND_RENEWAL_NOT_RENEWING")
      const seats = billableMemberCountSchema.parse(value.seats),
        pending = value.pending_update
      const currency = z.enum(["eur", "usd"]).parse(value.currency)
      if (
        pending &&
        (pending.units !== null ||
          new Date(pending.applies_at).toISOString() !== context.end ||
          (pending.product_id !== null &&
            !(
              snapshot.plan === "plus" &&
              pending.product_id === this.config.paidProducts.starter[currency]
            )) ||
          (pending.seats === null && pending.product_id === null))
      )
        throw new Error("BILLING_PENDING_CHANGE_CONFLICT")
      const renewalSeats =
        pending?.seats != null
          ? billableMemberCountSchema.parse(pending.seats)
          : seats
      return {
        value,
        snapshot,
        terminal: false as const,
        seats,
        renewalSeats,
        currency,
      }
    }
    const before = await observe()
    if (before.terminal)
      return { status: "terminated" as const, replayed: false }
    let after = before
    if (
      before.snapshot.plan === "plus" &&
      before.value.pending_update?.product_id !==
        this.config.paidProducts.starter[before.currency]
    ) {
      const fresh = await this.store.read(input)
      if (fresh.status !== "required")
        return { status: fresh.status, replayed: false }
      if (fresh.revision !== context.revision)
        throw new Error("BILLING_REFUND_RENEWAL_CONTEXT_CHANGED")
      // Explicit next_period avoids organization defaults and another charge/credit.
      await this.client.update(id, {
        product_id: this.config.paidProducts.starter[before.currency],
        proration_behavior: "next_period",
      })
      const observed = await observe()
      if (observed.terminal)
        return { status: "terminated" as const, replayed: false }
      after = observed
    }
    if (
      after.snapshot.plan !== before.snapshot.plan ||
      after.value.amount !== before.value.amount ||
      after.currency !== before.currency ||
      after.seats !== before.seats ||
      after.renewalSeats !== before.renewalSeats ||
      (after.snapshot.plan === "plus" &&
        after.value.pending_update?.product_id !==
          this.config.paidProducts.starter[after.currency])
    )
      throw new Error("BILLING_REFUND_RENEWAL_NOT_CONFIRMED")
    return this.store.confirm(input, {
      revision: context.revision,
      effectiveAt: context.end,
      providerUpdatedAt: after.snapshot.updatedAt.toISOString(),
      currency: after.currency,
      productId: this.config.paidProducts.starter[after.currency],
      billedSeats: after.seats,
      renewalSeats: after.renewalSeats,
      status:
        after.snapshot.plan === "starter" ? "already-starter" : "scheduled",
    })
  }
}
