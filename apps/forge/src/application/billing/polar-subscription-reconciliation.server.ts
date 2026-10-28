import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { applyVerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { VerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Subscription = Awaited<ReturnType<Polar["subscriptions"]["get"]>>
type ProviderSubscription = Pick<
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
> & { customer: Pick<Subscription["customer"], "external_id"> }

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
    if (
      subscription.id !== input.subscriptionId ||
      subscription.customer.external_id !==
        `forge:workspace:${input.workspaceId}`
    )
      throw new Error("BILLING_PROVIDER_IDENTITY_MISMATCH")
    const products = Object.entries(this.config.paidProducts)
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
    const product = products[0]
    if (subscription.status !== "active" && subscription.status !== "past_due")
      throw new Error("BILLING_LIFECYCLE_POLICY_REQUIRED")
    const date = (value: string | null | undefined) =>
      z.iso
        .datetime({ offset: true })
        .transform((v) => new Date(v))
        .parse(value)
    const snapshot: VerifiedSubscriptionSnapshot = {
      workspaceId: input.workspaceId,
      environment: this.config.environment,
      subscriptionId: subscription.id,
      plan: product.plan === "starter" ? "starter" : "plus",
      status: subscription.status,
      updatedAt: date(subscription.modified_at),
      currentPeriodStart: date(subscription.current_period_start),
      currentPeriodEnd: date(subscription.current_period_end),
      pastDueAt:
        subscription.status === "past_due"
          ? date(subscription.past_due_at)
          : null,
    }
    return this.apply({
      eventId: input.eventId,
      bodyHash: input.bodyHash,
      snapshot,
    })
  }
}
