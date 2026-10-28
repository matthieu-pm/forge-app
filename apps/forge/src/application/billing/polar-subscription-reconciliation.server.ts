import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { applyVerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { VerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Subscription = Awaited<ReturnType<Polar["subscriptions"]["get"]>>
export type ProviderSubscription = Pick<
  Subscription,
  | "id"
  | "product_id"
  | "currency"
  | "status"
  | "modified_at"
  | "current_period_start"
  | "current_period_end"
  | "recurring_interval"
  | "recurring_interval_count"
  | "past_due_at"
  | "cancel_at_period_end"
  | "ends_at"
  | "ended_at"
> & { customer: Pick<Subscription["customer"], "external_id"> }

export function verifiedPolarSubscriptionSnapshot(
  config: EnabledBillingConfig,
  workspaceId: string,
  subscriptionId: string,
  subscription: ProviderSubscription
): VerifiedSubscriptionSnapshot {
  if (
    subscription.id !== subscriptionId ||
    subscription.customer.external_id !== `forge:workspace:${workspaceId}`
  )
    throw new Error("BILLING_PROVIDER_IDENTITY_MISMATCH")
  const products = Object.entries(config.paidProducts)
    .flatMap(([plan, prices]) =>
      Object.entries(prices).map(([currency, id]) => ({ plan, currency, id }))
    )
    .filter(
      (item) =>
        item.id === subscription.product_id &&
        item.currency === subscription.currency
    )
  if (
    products.length !== 1 ||
    subscription.recurring_interval !== "month" ||
    subscription.recurring_interval_count !== 1
  )
    throw new Error("BILLING_PROVIDER_CATALOG_MISMATCH")
  const status = z
    .enum(["active", "past_due", "canceled", "unpaid"])
    .safeParse(subscription.status)
  if (!status.success) throw new Error("BILLING_LIFECYCLE_POLICY_REQUIRED")
  const cancelAtPeriodEnd = z.boolean().parse(subscription.cancel_at_period_end)
  const date = (value: string | null | undefined) =>
    z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .parse(value)
  const updatedAt = date(subscription.modified_at)
  const end = date(subscription.current_period_end)
  const endedAt = subscription.ended_at ? date(subscription.ended_at) : null
  const terminalStatus = status.data === "canceled" || status.data === "unpaid"
  if (endedAt && (!terminalStatus || endedAt > updatedAt))
    throw new Error("BILLING_TERMINATION_STATE_INVALID")
  const terminatedAt =
    terminalStatus &&
    (endedAt || status.data === "unpaid" || !cancelAtPeriodEnd)
      ? (endedAt ?? updatedAt)
      : null
  if (
    !terminatedAt &&
    cancelAtPeriodEnd &&
    subscription.ends_at &&
    date(subscription.ends_at).getTime() !== end.getTime()
  )
    throw new Error("BILLING_CANCELLATION_BOUNDARY_MISMATCH")
  return {
    workspaceId,
    environment: config.environment,
    subscriptionId,
    plan: products[0].plan === "starter" ? "starter" : "plus",
    status: status.data === "unpaid" ? "canceled" : status.data,
    terminatedAt,
    updatedAt,
    currentPeriodStart: date(subscription.current_period_start),
    currentPeriodEnd: end,
    pastDueAt:
      subscription.status === "past_due"
        ? date(subscription.past_due_at)
        : null,
    cancelAtPeriodEnd:
      !terminatedAt &&
      (cancelAtPeriodEnd || subscription.status === "canceled"),
  }
}

export class PolarSubscriptionReconciler {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly client: {
      subscriptions: { get: (id: string) => Promise<ProviderSubscription> }
    } = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }),
    private readonly apply: typeof applyVerifiedSubscriptionSnapshot = applyVerifiedSubscriptionSnapshot
  ) {}

  async reconcile(input: {
    workspaceId: string
    subscriptionId: string
    eventId: string
    bodyHash: string
  }) {
    const subscription = await this.client.subscriptions.get(
      z.uuid().parse(input.subscriptionId)
    )
    const snapshot = verifiedPolarSubscriptionSnapshot(
      this.config,
      input.workspaceId,
      input.subscriptionId,
      subscription
    )
    return this.apply({
      eventId: input.eventId,
      bodyHash: input.bodyHash,
      snapshot,
    })
  }
}
