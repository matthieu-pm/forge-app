// @vitest-environment node
import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  PolarSubscriptionRefundReconciler,
  verifiedPolarPeriodRefund,
} from "./polar-subscription-refund.server"
import { handlePolarWebhook } from "./polar-webhook.server"
import type { ProviderRefundOrder } from "./polar-subscription-refund.server"
import type { EnabledBillingConfig } from "./billing-config.server"

vi.mock("./subscription-refund.server", () => ({
  applyVerifiedPeriodRefund: vi.fn(),
}))
vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
const orderId = "00000000-0000-4000-8000-000000000099",
  subscriptionId = "00000000-0000-4000-8000-000000000098"
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture",
  webhookSecret: "fixture-secret",
  appUrl: "http://localhost:3000",
  paidProducts: {
    starter: {
      usd: "00000000-0000-4000-8000-000000000001",
      eur: "00000000-0000-4000-8000-000000000002",
    },
    plus: {
      usd: "00000000-0000-4000-8000-000000000003",
      eur: "00000000-0000-4000-8000-000000000004",
    },
  },
}
const order: ProviderRefundOrder = {
  id: orderId,
  status: "refunded",
  net_amount: 1600,
  tax_amount: 320,
  total_amount: 1920,
  refunded_amount: 1600,
  refunded_tax_amount: 320,
  applied_balance_amount: 0,
  billing_reason: "subscription_cycle",
  currency: "usd",
  product_id: config.paidProducts.plus.usd,
  subscription_id: subscriptionId,
  modified_at: "2026-10-28T00:00:00Z",
  customer: { external_id: "forge:workspace:w1" },
  items: [
    {
      amount: 1600,
      tax_amount: 320,
      proration: false,
      start_timestamp: "2026-10-01T00:00:00Z",
      end_timestamp: "2026-11-01T00:00:00Z",
    },
  ],
}
describe("verified subscription-period refunds", () => {
  it("uses the fetched order line period, never the subscription's current period", () => {
    expect(
      verifiedPolarPeriodRefund(config, "w1", orderId, order)
    ).toMatchObject({
      subscriptionId,
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    })
  })
  it.each([
    { refunded_amount: 100, refunded_tax_amount: 20 },
    { refunded_amount: 1600, refunded_tax_amount: 319 },
    { refunded_amount: 0, refunded_tax_amount: 1 },
  ])("keeps access for verified positive partial totals: %j", (totals) => {
    expect(
      verifiedPolarPeriodRefund(config, "w1", orderId, {
        ...order,
        status: "partially_refunded",
        ...totals,
      })
    ).toMatchObject({ kind: "partial", subscriptionId })
  })
  it.each([
    { status: "partially_refunded" },
    {
      status: "partially_refunded",
      refunded_amount: 0,
      refunded_tax_amount: 0,
    },
    { status: "partially_refunded", refunded_amount: -1 },
    { status: "paid", refunded_amount: 100 },
    { refunded_tax_amount: 0 },
    { refunded_amount: 1920 },
    { applied_balance_amount: 500 },
    { billing_reason: "purchase" },
    { billing_reason: "subscription_update" },
    { customer: { external_id: "forge:workspace:other" } },
    { product_id: subscriptionId },
    { currency: "eur" },
    { subscription_id: null },
    { items: [] },
    { items: [...order.items, ...order.items] },
    { items: [{ ...order.items[0], proration: true }] },
    { items: [{ ...order.items[0], start_timestamp: null }] },
    { items: [{ ...order.items[0], end_timestamp: "2026-09-01T00:00:00Z" }] },
    { modified_at: null },
  ] satisfies Array<Partial<ProviderRefundOrder>>)(
    "refuses ambiguous or unverified allocation: %j",
    (patch) => {
      expect(() =>
        verifiedPolarPeriodRefund(config, "w1", orderId, { ...order, ...patch })
      ).toThrow()
    }
  )
  it("dispatches a signed refund using only the order identity and re-fetches the order", async () => {
    const get = vi.fn().mockResolvedValue(order),
      apply = vi.fn().mockResolvedValue({ outcome: "applied", replayed: false })
    const service = new PolarSubscriptionRefundReconciler(
      config,
      { orders: { get } },
      apply
    )
    const body = JSON.stringify({
        type: "order.refunded",
        data: {
          id: orderId,
          customer: order.customer,
          status: "partially_refunded",
        },
      }),
      timestamp = Math.floor(Date.now() / 1000),
      id = "refund-event"
    const signature = createHmac("sha256", config.webhookSecret)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
      },
    })
    expect(
      (await handlePolarWebhook(request, config, undefined, service)).status
    ).toBe(200)
    expect(get).toHaveBeenCalledWith(orderId)
    expect(apply).toHaveBeenCalledWith({
      eventId: id,
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      refund: expect.objectContaining({ orderId, subscriptionId }),
    })
  })
})
