import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { applyVerifiedPeriodRefund } from "./subscription-refund.server"
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
    .flatMap(([, prices]) => Object.entries(prices))
    .filter(
      ([currency, id]) => currency === order.currency && id === order.product_id
    )
  if (
    products.length !== 1 ||
    !["subscription_create", "subscription_cycle"].includes(
      order.billing_reason
    )
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
  if (
    order.items.length !== 1 ||
    order.items[0].proration ||
    cents.parse(order.items[0].amount) < net ||
    cents.parse(order.items[0].tax_amount) !== tax
  )
    throw new Error("BILLING_REFUND_ALLOCATION_REQUIRED")
  const start = instant.parse(order.items[0].start_timestamp),
    end = instant.parse(order.items[0].end_timestamp)
  if (start >= end) throw new Error("BILLING_REFUND_PERIOD_INVALID")
  return {
    kind,
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
      orders: { get: (id: string) => Promise<ProviderRefundOrder> }
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
    return this.apply({
      eventId: input.eventId,
      bodyHash: input.bodyHash,
      refund,
    })
  }
}
