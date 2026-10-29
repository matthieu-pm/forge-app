// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { PolarReplacementAnniversaryVerifier } from "./polar-replacement-anniversary.server"
import type {
  ReplacementAnniversaryContext,
  ReplacementCheckout,
  ReplacementOrder,
  ReplacementSubscription,
} from "./polar-replacement-anniversary.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { Actor } from "@/application/actor"

vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
const source = "00000000-0000-4000-8000-000000000010",
  replacement = "00000000-0000-4000-8000-000000000011",
  request = "00000000-0000-4000-8000-000000000012",
  orderId = "00000000-0000-4000-8000-000000000013",
  checkoutId = "00000000-0000-4000-8000-000000000014"
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture",
  webhookSecret: "fixture",
  appUrl: "https://forge.test",
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
const actor: Actor = {
  workspaceId: "w1",
  userId: "owner",
  workspaceRole: "owner",
  scopes: null,
  authentication: { kind: "session", sessionId: "fixture" },
}
function fixture() {
  const paid = "2027-02-05T20:00:00.000Z",
    end = "2027-03-05T20:00:00.000Z",
    now = new Date("2027-02-06T10:00:00.000Z")
  const context: ReplacementAnniversaryContext = {
    requestId: request,
    workspaceId: "w1",
    environment: "sandbox",
    sourceSubscriptionId: source,
    targetCurrency: "eur",
    renewalPlan: "starter",
    renewalMembers: 2,
    renewalPriceMinor: 2000,
    originalPeriodStart: new Date("2026-12-31T17:00:00.000Z"),
    effectiveAt: new Date("2027-01-31T17:00:00.000Z"),
    anchorDay: 31,
    nextRenewalAt: new Date("2027-02-28T17:00:00.000Z"),
    checkoutGraceEndsAt: new Date("2027-02-07T17:00:00.000Z"),
  }
  const subscription: ReplacementSubscription = {
    id: replacement,
    product_id: config.paidProducts.starter.eur,
    currency: "eur",
    customer: { external_id: "forge:workspace:w1" },
    status: "active",
    modified_at: paid,
    current_period_start: paid,
    current_period_end: end,
    recurring_interval: "month",
    recurring_interval_count: 1,
    past_due_at: null,
    cancel_at_period_end: false,
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    pending_update: null,
    trial_start: null,
    trial_end: null,
    amount: 2000,
    seats: 2,
  }
  const checkout: ReplacementCheckout = {
    id: checkoutId,
    created_at: "2027-02-05T19:00:00.000Z",
    modified_at: paid,
    status: "succeeded",
    amount: 2000,
    seats: 2,
    discount_amount: 0,
    net_amount: 2000,
    tax_amount: 400,
    tax_behavior: "exclusive",
    total_amount: 2400,
    currency: "eur",
    product_id: config.paidProducts.starter.eur,
    allow_trial: false,
    trial_end: null,
    external_customer_id: "forge:workspace:w1",
    customer_billing_address: {
      country: "FR",
      line1: null,
      line2: null,
      postal_code: null,
      city: null,
      state: null,
    },
    metadata: {
      currency_change_request_id: request,
      workspace_id: "w1",
      source_subscription_id: source,
    },
    subscription_id: null,
  }
  const order: ReplacementOrder = {
    id: orderId,
    checkout_id: checkoutId,
    subscription_id: replacement,
    product_id: config.paidProducts.starter.eur,
    currency: "eur",
    billing_reason: "subscription_create",
    status: "paid",
    paid: true,
    net_amount: 2000,
    tax_amount: 400,
    total_amount: 2400,
    due_amount: 2400,
    applied_balance_amount: 0,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    created_at: paid,
    customer: { external_id: "forge:workspace:w1" },
    items: [
      {
        proration: false,
        start_timestamp: paid,
        end_timestamp: end,
        amount: 2000,
      },
    ],
  }
  const resolve = vi.fn(() => Promise.resolve(structuredClone(context)))
  const client = {
    orders: { get: vi.fn(() => Promise.resolve(structuredClone(order))) },
    checkouts: { get: vi.fn(() => Promise.resolve(structuredClone(checkout))) },
    subscriptions: {
      get: vi.fn(() => Promise.resolve(structuredClone(subscription))),
    },
  }
  return {
    context,
    subscription,
    checkout,
    order,
    client,
    resolve,
    service: new PolarReplacementAnniversaryVerifier(
      config,
      resolve,
      client,
      () => now
    ),
  }
}
describe("paid replacement anniversary proof and read-only plan", () => {
  it("verifies the bound payment and retains original usage/renewal with a short-month follow-up", async () => {
    const f = fixture()
    expect(await f.service.plan(actor, request, orderId)).toMatchObject({
      usagePeriodStart: "2027-01-31T17:00:00.000Z",
      usagePeriodEnd: "2027-02-28T17:00:00.000Z",
      originalPaidPeriodEnd: "2027-03-05T20:00:00.000Z",
      followingPeriodEnd: "2027-03-31T17:00:00.000Z",
      followUpRequired: true,
      periodAdjustmentRequired: true,
      paymentVerified: true,
      grantsFreshPaidPool: false,
      providerChangeScheduled: false,
      requiresVerifiedSourceStop: true,
      requiresAtomicCutover: true,
    })
    expect(f.resolve).toHaveBeenCalledTimes(2)
    expect(f.client.orders.get).toHaveBeenCalledExactlyOnceWith(orderId)
    expect(f.client.checkouts.get).toHaveBeenCalledExactlyOnceWith(checkoutId)
    expect(f.client.subscriptions.get).toHaveBeenCalledExactlyOnceWith(
      replacement
    )
  })
  it("can re-verify an already aligned provider period against the retained original invoice window", async () => {
    const f = fixture()
    f.subscription.current_period_end = f.context.nextRenewalAt.toISOString()
    expect(
      (await f.service.plan(actor, request, orderId)).periodAdjustmentRequired
    ).toBe(false)
  })
  it.each([
    { status: "confirmed" },
    { currency: "usd" },
    { seats: 3 },
    { allow_trial: true },
    { trial_end: "2027-02-20T00:00:00Z" },
    { discount_amount: 1 },
    { tax_behavior: "inclusive" },
    { tax_behavior: null },
    { external_customer_id: "forge:workspace:other" },
    { subscription_id: source },
    { metadata: { workspace_id: "w1" } },
    { customer_billing_address: null },
    { modified_at: "2027-02-06T11:00:00Z" },
  ] satisfies Array<Partial<ReplacementCheckout>>)(
    "refuses mismatched, incomplete or trial checkout: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.checkout, patch)
      await expect(f.service.plan(actor, request, orderId)).rejects.toThrow()
    }
  )
  it.each([
    { paid: false },
    { status: "pending" },
    { due_amount: 1 },
    { refunded_amount: 1 },
    { billing_reason: "subscription_cycle" },
    { net_amount: 1999 },
    { total_amount: 2000 },
    { product_id: config.paidProducts.plus.eur },
    { customer: { external_id: "forge:workspace:other" } },
    { items: [] },
    {
      items: [
        {
          proration: true,
          start_timestamp: "2027-02-05T20:00:00Z",
          end_timestamp: "2027-03-05T20:00:00Z",
          amount: 2000,
        },
      ],
    },
  ] satisfies Array<Partial<ReplacementOrder>>)(
    "refuses invalid or noninitial payment proof: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.order, patch)
      await expect(f.service.plan(actor, request, orderId)).rejects.toThrow()
    }
  )
  it.each([
    { status: "past_due", past_due_at: "2027-02-05T20:00:00Z" },
    { pause_at_period_end: true },
    { cancel_at_period_end: true },
    { amount: 1600 },
    { seats: 1 },
    { trial_start: "2027-02-05T20:00:00Z" },
    { current_period_start: "2027-01-31T16:59:59Z" },
    { current_period_start: "2027-02-07T17:00:00Z" },
    { current_period_end: "2027-03-06T20:00:00Z" },
  ] satisfies Array<Partial<ReplacementSubscription>>)(
    "refuses unpaid, restricted or unrelated subscription: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.subscription, patch)
      await expect(f.service.plan(actor, request, orderId)).rejects.toThrow()
    }
  )
  it("refuses a changed or revoked context after provider reads", async () => {
    const f = fixture()
    f.resolve
      .mockImplementationOnce(() => Promise.resolve(structuredClone(f.context)))
      .mockImplementationOnce(() =>
        Promise.resolve({ ...f.context, renewalMembers: 3 })
      )
    await expect(f.service.plan(actor, request, orderId)).rejects.toThrow(
      "CONTEXT_CHANGED"
    )
    const g = fixture()
    g.resolve
      .mockImplementationOnce(() => Promise.resolve(structuredClone(g.context)))
      .mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(g.service.plan(actor, request, orderId)).rejects.toThrow(
      "REVOKED"
    )
  })
  it("refuses another environment/workspace before provider reads", async () => {
    const f = fixture()
    f.context.environment = "production"
    await expect(f.service.plan(actor, request, orderId)).rejects.toThrow(
      "CONTEXT_CHANGED"
    )
    expect(f.client.orders.get).not.toHaveBeenCalled()
    f.context.environment = "sandbox"
    f.context.workspaceId = "other"
    await expect(f.service.plan(actor, request, orderId)).rejects.toThrow(
      "CONTEXT_CHANGED"
    )
  })
})
