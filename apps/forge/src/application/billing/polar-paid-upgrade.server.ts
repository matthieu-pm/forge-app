import "@tanstack/react-start/server-only"
import { z } from "zod"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Order = Awaited<ReturnType<Polar["orders"]["get"]>>
export type UpgradeOrder = Pick<
  Order,
  | "id"
  | "subscription_id"
  | "product_id"
  | "currency"
  | "billing_reason"
  | "status"
  | "paid"
  | "net_amount"
  | "tax_amount"
  | "total_amount"
  | "due_amount"
  | "applied_balance_amount"
  | "refunded_amount"
  | "refunded_tax_amount"
  | "created_at"
> & {
  customer: Pick<Order["customer"], "external_id">
  items: Array<
    Pick<
      Order["items"][number],
      "proration" | "start_timestamp" | "end_timestamp" | "amount"
    >
  >
}
export type UpgradePaymentContext = {
  workspaceId: string
  subscriptionId: string
  productId: string
  currency: string
  periodStart: Date
  periodEnd: Date
}
export type UpgradeOrderClient = {
  get: (id: string) => Promise<UpgradeOrder>
  list: (
    query: Parameters<Polar["orders"]["list"]>[0]
  ) => Promise<{ items: Array<UpgradeOrder>; pagination: { max_page: number } }>
}
const cents = z.number().int().nonnegative().safe()
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v))

/** Polar's due_amount is the original invoice total after applied balance,
 * not the remaining unpaid balance. Paid/status fields prove payment. */
export function consistentPaidInvoiceAmounts(
  order: Pick<
    UpgradeOrder,
    | "net_amount"
    | "tax_amount"
    | "total_amount"
    | "due_amount"
    | "applied_balance_amount"
    | "refunded_amount"
    | "refunded_tax_amount"
  >
) {
  if (
    ![
      order.net_amount,
      order.tax_amount,
      order.total_amount,
      order.due_amount,
      order.refunded_amount,
      order.refunded_tax_amount,
    ].every((v) => cents.safeParse(v).success) ||
    !z.number().int().safe().safeParse(order.applied_balance_amount).success
  )
    return false
  const total = BigInt(order.total_amount),
    due = total + BigInt(order.applied_balance_amount)
  return (
    BigInt(order.net_amount) + BigInt(order.tax_amount) === total &&
    BigInt(order.due_amount) === (due > 0n ? due : 0n) &&
    order.refunded_amount <= order.net_amount &&
    order.refunded_tax_amount <= order.tax_amount
  )
}

/** Only a current, paid, non-fully-refunded invoice can prove a paid tier upgrade. */
export function verifiedPaidUpgradeOrder(
  context: UpgradePaymentContext,
  order: UpgradeOrder
) {
  if (
    order.customer.external_id !== `forge:workspace:${context.workspaceId}` ||
    order.subscription_id !== context.subscriptionId ||
    order.product_id !== context.productId ||
    order.currency !== context.currency ||
    order.paid !== true ||
    !["paid", "partially_refunded"].includes(order.status) ||
    !["subscription_update", "subscription_cycle"].includes(
      order.billing_reason
    )
  )
    return null
  if (
    !consistentPaidInvoiceAmounts(order) ||
    (order.total_amount === 0 && order.status !== "paid") ||
    (order.total_amount > 0 &&
      order.refunded_amount + order.refunded_tax_amount >= order.total_amount)
  )
    return null
  const created = instant.safeParse(order.created_at)
  if (
    !z.uuid().safeParse(order.id).success ||
    !created.success ||
    created.data < context.periodStart ||
    created.data >= context.periodEnd ||
    !Array.isArray(order.items) ||
    !order.items.length
  )
    return null
  const subtotal = order.items.reduce((total, item) => total + item.amount, 0)
  if (!Number.isSafeInteger(subtotal) || subtotal < order.net_amount)
    return null
  for (const item of order.items) {
    const start = instant.safeParse(item.start_timestamp),
      end = instant.safeParse(item.end_timestamp)
    if (
      !start.success ||
      !end.success ||
      !Number.isSafeInteger(item.amount) ||
      typeof item.proration !== "boolean" ||
      start.data >= end.data ||
      end.data.getTime() !== context.periodEnd.getTime()
    )
      return null
    if (
      order.billing_reason === "subscription_update"
        ? !item.proration || start.data < context.periodStart
        : item.proration ||
          start.data.getTime() !== context.periodStart.getTime()
    )
      return null
  }
  return {
    orderId: order.id,
    subscriptionId: context.subscriptionId,
    periodStart: context.periodStart,
    periodEnd: context.periodEnd,
    createdAt: created.data,
  }
}

export async function findPaidUpgradeOrder(
  client: UpgradeOrderClient,
  context: UpgradePaymentContext
) {
  // Bound reconciliation work. Validate the lower date boundary locally so an
  // invoice exactly at period start remains eligible. Missing proof is pending.
  for (let page = 1; page <= 3; page++) {
    const result = await client.list({
      subscription_id: context.subscriptionId,
      external_customer_id: `forge:workspace:${context.workspaceId}`,
      product_id: context.productId,
      status: ["paid", "partially_refunded"],
      created_before: context.periodEnd.toISOString(),
      sorting: ["-created_at"],
      limit: 100,
      page,
    })
    for (const order of result.items) {
      const proof = verifiedPaidUpgradeOrder(context, order)
      if (proof) return proof
    }
    if (page >= result.pagination.max_page) break
  }
  return undefined
}

/** Prove the original nonprorated Starter term behind a refunded upgrade. */
export async function findPaidStarterBasis(
  client: Pick<UpgradeOrderClient, "list">,
  context: Omit<UpgradePaymentContext, "periodStart"> & { upgradeStart: Date }
) {
  for (let page = 1; page <= 3; page++) {
    const result = await client.list({
      subscription_id: context.subscriptionId,
      external_customer_id: `forge:workspace:${context.workspaceId}`,
      product_id: context.productId,
      status: ["paid", "partially_refunded"],
      created_before: context.periodEnd.toISOString(),
      sorting: ["-created_at"],
      limit: 100,
      page,
    })
    for (const order of result.items) {
      if (
        !["subscription_create", "subscription_cycle"].includes(
          order.billing_reason
        )
      )
        continue
      const start = instant.safeParse(order.items[0]?.start_timestamp)
      if (!start.success || start.data > context.upgradeStart) continue
      // Both base-order reasons use the same full-period, nonprorated checks.
      const proof = verifiedPaidUpgradeOrder(
        { ...context, periodStart: start.data },
        { ...order, billing_reason: "subscription_cycle" }
      )
      if (proof)
        return {
          orderId: proof.orderId,
          start: proof.periodStart.toISOString(),
          end: proof.periodEnd.toISOString(),
        }
    }
    if (page >= result.pagination.max_page) break
  }
  return undefined
}
