import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { findPaidStarterBasis } from "./polar-paid-upgrade.server"
import { applyVerifiedPeriodRefund } from "./subscription-refund.server"
import type { UpgradeOrderClient } from "./polar-paid-upgrade.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Order = Awaited<ReturnType<Polar["orders"]["get"]>>
export type ProviderRefundOrder = Pick<
  Order,
  | "id"
  | "status"
  | "net_amount"
  | "tax_amount"
  | "total_amount"
  | "refunded_amount"
  | "refunded_tax_amount"
  | "applied_balance_amount"
  | "billing_reason"
  | "currency"
  | "product_id"
  | "subscription_id"
  | "modified_at"
> & {
  customer: Pick<Order["customer"], "external_id">
  items: Array<
    Pick<
      Order["items"][number],
      | "amount"
      | "tax_amount"
      | "proration"
      | "start_timestamp"
      | "end_timestamp"
    >
  >
}
const cents = z.number().int().nonnegative().safe()
const instant = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString())

export function verifiedPolarPeriodRefund(
  config: EnabledBillingConfig,
  workspaceId: string,
  orderId: string,
  order: ProviderRefundOrder
) {
  if (
    order.id !== orderId ||
    order.customer.external_id !== `forge:workspace:${workspaceId}`
  )
    throw new Error("BILLING_PROVIDER_IDENTITY_MISMATCH")
  const products = Object.entries(config.paidProducts)
    .flatMap(([plan, prices]) =>
      Object.entries(prices).map(([currency, id]) => ({ plan, currency, id }))
    )
    .filter(
      (item) => item.currency === order.currency && item.id === order.product_id
    )
  const upgrade =
    order.billing_reason === "subscription_update" &&
    products[0]?.plan === "plus"
  if (
    products.length !== 1 ||
    (!upgrade &&
      !["subscription_create", "subscription_cycle"].includes(
        order.billing_reason
      ))
  )
    throw new Error("BILLING_REFUND_SCOPE_REQUIRED")
  const net = cents.parse(order.net_amount),
    tax = cents.parse(order.tax_amount)
  const refundedNet = cents.parse(order.refunded_amount),
    refundedTax = cents.parse(order.refunded_tax_amount)
  // Balance credits and mixed/prorated invoices need their own allocation policy.
  if (
    net <= 0 ||
    cents.parse(order.total_amount) !== net + tax ||
    order.applied_balance_amount !== 0 ||
    refundedNet > net ||
    refundedTax > tax
  )
    throw new Error("BILLING_REFUND_AMOUNT_INVALID")
  const full = refundedNet === net && refundedTax === tax
  const kind: "full" | "partial" = full ? "full" : "partial"
  if (
    (full && order.status !== "refunded") ||
    (!full &&
      (order.status !== "partially_refunded" ||
        refundedNet + refundedTax <= 0 ||
        refundedNet + refundedTax >= net + tax))
  )
    throw new Error("BILLING_REFUND_STATUS_INVALID")
  if (!order.items.length) throw new Error("BILLING_REFUND_ALLOCATION_REQUIRED")
  const start = instant.parse(order.items[0].start_timestamp),
    end = instant.parse(order.items[0].end_timestamp)
  if (start >= end) throw new Error("BILLING_REFUND_PERIOD_INVALID")
  if (upgrade) {
    if (
      order.items.some(
        (item) =>
          item.proration !== true ||
          !Number.isSafeInteger(item.amount) ||
          !Number.isSafeInteger(item.tax_amount) ||
          instant.parse(item.start_timestamp) !== start ||
          instant.parse(item.end_timestamp) !== end
      ) ||
      order.items.reduce((total, item) => total + item.amount, 0) < net ||
      order.items.reduce((total, item) => total + item.tax_amount, 0) !== tax
    )
      throw new Error("BILLING_REFUND_ALLOCATION_REQUIRED")
  } else if (
    order.items.length !== 1 ||
    order.items[0].proration !== false ||
    cents.parse(order.items[0].amount) < net ||
    cents.parse(order.items[0].tax_amount) !== tax
  )
    throw new Error("BILLING_REFUND_ALLOCATION_REQUIRED")
  return {
    kind,
    scope: upgrade ? ("upgrade" as const) : ("period" as const),
    workspaceId,
    environment: config.environment,
    orderId: z.uuid().parse(orderId),
    subscriptionId: z.uuid().parse(order.subscription_id),
    start,
    end,
    refundedAt: instant.parse(order.modified_at),
  }
}

export class PolarSubscriptionRefundReconciler {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly client: {
      orders: {
        get: (id: string) => Promise<ProviderRefundOrder>
        list?: UpgradeOrderClient["list"]
      }
    } = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }),
    private readonly apply: typeof applyVerifiedPeriodRefund = applyVerifiedPeriodRefund
  ) {}
  async reconcile(input: {
    workspaceId: string
    orderId: string
    eventId: string
    bodyHash: string
  }) {
    const order = await this.client.orders.get(z.uuid().parse(input.orderId))
    const refund = verifiedPolarPeriodRefund(
      this.config,
      input.workspaceId,
      input.orderId,
      order
    )
    let starterBasis
    if (
      refund.scope === "upgrade" &&
      refund.kind === "full" &&
      this.client.orders.list
    ) {
      try {
        starterBasis = await findPaidStarterBasis(
          { list: this.client.orders.list },
          {
            workspaceId: input.workspaceId,
            subscriptionId: refund.subscriptionId,
            productId:
              this.config.paidProducts.starter[
                z.enum(["usd", "eur"]).parse(order.currency)
              ],
            currency: order.currency,
            upgradeStart: new Date(refund.start),
            periodEnd: new Date(refund.end),
          }
        )
      } catch {
        /* Persist restrictive denial before retrying unavailable base proof. */
      }
    }
    const result = await this.apply({
      eventId: input.eventId,
      bodyHash: input.bodyHash,
      refund: { ...refund, starterBasis },
    })
    if (refund.scope === "upgrade" && refund.kind === "full" && !starterBasis)
      throw new Error("BILLING_STARTER_BASE_RECONCILIATION_REQUIRED")
    return result
  }
}
