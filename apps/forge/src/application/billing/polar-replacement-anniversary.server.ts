import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import { monthlyWorkspacePrice } from "./billing-plan-contract"
import { workspaceBillingCurrency } from "./billing-country"
import {
  nextAnchoredMonth,
  replacementAnniversarySchedule,
} from "./monthly-billing-anchor"
import { verifiedPolarSubscriptionSnapshot } from "./polar-subscription-reconciliation.server"
import { consistentPaidInvoiceAmounts } from "./polar-paid-upgrade.server"
import type { Actor } from "@/application/actor"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { UpgradeOrder } from "./polar-paid-upgrade.server"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Checkout = Awaited<ReturnType<Polar["checkouts"]["get"]>>
type Subscription = Awaited<ReturnType<Polar["subscriptions"]["get"]>>
type Order = Awaited<ReturnType<Polar["orders"]["get"]>>
export type ReplacementCheckout = Pick<
  Checkout,
  | "id"
  | "created_at"
  | "modified_at"
  | "status"
  | "amount"
  | "seats"
  | "discount_amount"
  | "net_amount"
  | "tax_amount"
  | "tax_behavior"
  | "total_amount"
  | "currency"
  | "product_id"
  | "allow_trial"
  | "trial_end"
  | "external_customer_id"
  | "customer_billing_address"
  | "metadata"
  | "subscription_id"
>
export type ReplacementSubscription = ProviderSubscription &
  Pick<
    Subscription,
    "amount" | "seats" | "pending_update" | "trial_start" | "trial_end"
  >
export type ReplacementOrder = UpgradeOrder & Pick<Order, "checkout_id">
const contextSchema = z.object({
  requestId: z.uuid(),
  workspaceId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  sourceSubscriptionId: z.uuid(),
  targetCurrency: z.enum(["eur", "usd"]),
  renewalPlan: z.enum(["starter", "plus"]),
  renewalMembers: z.number().int().positive().safe(),
  renewalPriceMinor: z.number().int().positive().safe(),
  originalPeriodStart: z.date(),
  effectiveAt: z.date(),
  anchorDay: z.number().int().min(1).max(31),
  nextRenewalAt: z.date(),
  checkoutGraceEndsAt: z.date(),
})
export type ReplacementAnniversaryContext = z.infer<typeof contextSchema>
type Client = {
  orders: { get: (id: string) => Promise<ReplacementOrder> }
  checkouts: { get: (id: string) => Promise<ReplacementCheckout> }
  subscriptions: { get: (id: string) => Promise<ReplacementSubscription> }
}
const instant = (value: string | null) =>
  z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .parse(value)
const cents = z.number().int().nonnegative().safe()

/** Read-only proof/plan. No PATCH, cancellation, entitlement rebind or grant. */
export class PolarReplacementAnniversaryVerifier {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly resolve: (
      actor: Actor,
      requestId: string
    ) => Promise<ReplacementAnniversaryContext>,
    private readonly client: Client = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }),
    private readonly clock: () => Date = () => new Date()
  ) {}

  async plan(actor: Actor, requestId: string, orderId: string) {
    const identity = workspaceBillingIdentity(actor),
      key = z.uuid().parse(requestId),
      orderKey = z.uuid().parse(orderId)
    const context = contextSchema.parse(await this.resolve(actor, key))
    if (
      context.requestId !== key ||
      context.workspaceId !== identity.workspaceId ||
      context.environment !== this.config.environment ||
      monthlyWorkspacePrice(context.renewalPlan, context.renewalMembers) !==
        context.renewalPriceMinor
    )
      throw new Error("BILLING_REPLACEMENT_CONTEXT_CHANGED")
    const order = await this.client.orders.get(orderKey)
    const subId = z.uuid().parse(order.subscription_id),
      checkoutId = z.uuid().parse(order.checkout_id)
    if (order.id !== orderKey || subId === context.sourceSubscriptionId)
      throw new Error("BILLING_REPLACEMENT_IDENTITY_MISMATCH")
    const [subscription, checkout] = await Promise.all([
      this.client.subscriptions.get(subId),
      this.client.checkouts.get(checkoutId),
    ])
    const snapshot = verifiedPolarSubscriptionSnapshot(
      this.config,
      identity.workspaceId,
      subId,
      subscription
    )
    const paidAt = snapshot.currentPeriodStart,
      now = this.clock()
    const schedule = replacementAnniversarySchedule({ ...context, paidAt })
    const originalPaidEnd = nextAnchoredMonth(paidAt, paidAt.getUTCDate())
    const product =
      this.config.paidProducts[context.renewalPlan][context.targetCurrency]
    const refused = () => {
      throw new Error("BILLING_REPLACEMENT_PAYMENT_UNVERIFIED")
    }
    if (
      snapshot.plan !== context.renewalPlan ||
      snapshot.status !== "active" ||
      snapshot.cancelAtPeriodEnd ||
      snapshot.terminatedAt ||
      snapshot.unsupportedPauseAt ||
      subscription.resumes_at !== null ||
      subscription.ends_at !== null ||
      subscription.ended_at !== null ||
      subscription.pending_update !== null ||
      subscription.trial_start !== null ||
      subscription.trial_end !== null ||
      subscription.amount !== context.renewalPriceMinor ||
      subscription.seats !== context.renewalMembers ||
      paidAt > now ||
      snapshot.updatedAt < paidAt ||
      snapshot.updatedAt > now ||
      context.nextRenewalAt <= now ||
      ![originalPaidEnd.getTime(), context.nextRenewalAt.getTime()].includes(
        snapshot.currentPeriodEnd.getTime()
      )
    )
      refused()
    if (
      checkout.id !== checkoutId ||
      checkout.status !== "succeeded" ||
      checkout.external_customer_id !== identity.externalCustomerId ||
      (checkout.subscription_id !== null &&
        checkout.subscription_id !== subId) ||
      checkout.metadata.currency_change_request_id !== key ||
      checkout.metadata.workspace_id !== identity.workspaceId ||
      checkout.metadata.source_subscription_id !==
        context.sourceSubscriptionId ||
      checkout.product_id !== product ||
      checkout.currency !== context.targetCurrency ||
      workspaceBillingCurrency(checkout.customer_billing_address?.country)
        .currency !== context.targetCurrency ||
      checkout.seats !== context.renewalMembers ||
      checkout.amount !== context.renewalPriceMinor ||
      checkout.net_amount !== context.renewalPriceMinor ||
      checkout.discount_amount !== 0 ||
      checkout.tax_behavior !== "exclusive" ||
      checkout.allow_trial !== false ||
      checkout.trial_end !== null ||
      instant(checkout.created_at) > paidAt ||
      instant(checkout.modified_at) < paidAt ||
      instant(checkout.modified_at) > now
    )
      refused()
    if (
      order.customer.external_id !== identity.externalCustomerId ||
      order.product_id !== product ||
      order.currency !== context.targetCurrency ||
      order.billing_reason !== "subscription_create" ||
      order.paid !== true ||
      order.status !== "paid" ||
      order.net_amount !== context.renewalPriceMinor ||
      !consistentPaidInvoiceAmounts(order) ||
      order.refunded_amount !== 0 ||
      order.refunded_tax_amount !== 0 ||
      instant(order.created_at) < instant(checkout.created_at) ||
      instant(order.created_at) > now ||
      ![
        order.net_amount,
        order.tax_amount,
        order.total_amount,
        order.due_amount,
        order.refunded_amount,
        order.refunded_tax_amount,
        checkout.tax_amount,
        checkout.total_amount,
      ].every((v) => cents.safeParse(v).success) ||
      order.net_amount + order.tax_amount !== order.total_amount ||
      order.tax_amount !== checkout.tax_amount ||
      order.total_amount !== checkout.total_amount ||
      !order.items.length
    )
      refused()
    let sum = 0
    for (const item of order.items) {
      if (
        !cents.safeParse(item.amount).success ||
        item.proration !== false ||
        instant(item.start_timestamp).getTime() !== paidAt.getTime() ||
        instant(item.end_timestamp).getTime() !== originalPaidEnd.getTime()
      )
        refused()
      sum += item.amount
    }
    if (!Number.isSafeInteger(sum) || sum !== order.net_amount) refused()
    const refreshed = contextSchema.parse(await this.resolve(actor, key))
    if (JSON.stringify(refreshed) !== JSON.stringify(context))
      throw new Error("BILLING_REPLACEMENT_CONTEXT_CHANGED")
    return {
      ...schedule,
      requestId: key,
      checkoutId,
      orderId: orderKey,
      replacementSubscriptionId: subId,
      originalPaidPeriodEnd: originalPaidEnd.toISOString(),
      expectedProviderPeriodEnd: snapshot.currentPeriodEnd.toISOString(),
      periodAdjustmentRequired:
        snapshot.currentPeriodEnd.getTime() !== context.nextRenewalAt.getTime(),
      paymentVerified: true as const,
      providerChangeScheduled: false as const,
      // A paid invoice and calendar plan cannot authorize either of these effects.
      requiresVerifiedSourceStop: true as const,
      requiresAtomicCutover: true as const,
    }
  }
}

/** Default live context for internal reconciliation; not a browser action. */
export async function readReplacementAnniversaryContext(
  actor: Actor,
  requestId: string,
  environment: "sandbox" | "production"
): Promise<ReplacementAnniversaryContext> {
  const { readCancellationContext } =
    await import("./subscription-cancellation-context.server")
  const { db, workspaceCurrencyChangeRequests } = await import("@/db")
  const { eq } = await import("drizzle-orm")
  const binding = await readCancellationContext(actor, environment)
  const row = await db.query.workspaceCurrencyChangeRequests.findFirst({
    where: eq(workspaceCurrencyChangeRequests.id, z.uuid().parse(requestId)),
  })
  if (
    !row ||
    row.workspaceId !== binding.workspaceId ||
    row.environment !== environment ||
    row.subscriptionId !== binding.subscriptionId ||
    row.state !== "requested"
  )
    throw new Error("BILLING_REPLACEMENT_CONTEXT_CHANGED")
  // Never infer the original day from a single clamped boundary on legacy rows.
  return contextSchema.parse({
    ...row,
    requestId: row.id,
    sourceSubscriptionId: row.subscriptionId,
    anchorDay: row.billingAnchorDay,
  })
}
