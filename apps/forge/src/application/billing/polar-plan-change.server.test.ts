// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  PolarSubscriptionRefundReconciler,
  verifiedPolarPeriodRefund,
} from "./polar-subscription-refund.server"
import { PolarPlanChanger } from "./polar-plan-change.server"
import {
  findPaidUpgradeOrder,
  verifiedPaidUpgradeOrder,
} from "./polar-paid-upgrade.server"
import type { ProviderRefundOrder } from "./polar-subscription-refund.server"
import type { PlanChangeSubscription } from "./polar-plan-change.server"
import type { UpgradeOrder } from "./polar-paid-upgrade.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { Actor } from "@/application/actor"

vi.mock("./subscription-refund.server", () => ({
  applyVerifiedPeriodRefund: vi.fn(),
}))
vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
type Client = NonNullable<ConstructorParameters<typeof PolarPlanChanger>[2]>
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture",
  webhookSecret: "fixture-secret",
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
const id = "00000000-0000-4000-8000-000000000099",
  orderId = "00000000-0000-4000-8000-000000000098"
const start = "2026-10-01T00:00:00.000Z",
  end = "2026-11-01T00:00:00.000Z",
  now = new Date("2026-10-28T00:00:00Z")
const actor: Actor = {
  workspaceId: "w1",
  userId: "owner",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "fixture" },
  scopes: null,
}
function order(): UpgradeOrder {
  return {
    id: orderId,
    subscription_id: id,
    product_id: config.paidProducts.plus.eur,
    currency: "eur",
    customer: { external_id: "forge:workspace:w1" },
    status: "paid",
    paid: true,
    billing_reason: "subscription_update",
    net_amount: 60,
    tax_amount: 12,
    total_amount: 72,
    due_amount: 0,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    created_at: now.toISOString(),
    items: [
      {
        proration: true,
        amount: -100,
        start_timestamp: now.toISOString(),
        end_timestamp: end,
      },
      {
        proration: true,
        amount: 160,
        start_timestamp: now.toISOString(),
        end_timestamp: end,
      },
    ],
  }
}
const paymentContext = {
  workspaceId: "w1",
  subscriptionId: id,
  productId: config.paidProducts.plus.eur,
  currency: "eur",
  periodStart: new Date(start),
  periodEnd: new Date(end),
}
function fixture(plan: "starter" | "plus" = "starter") {
  const current: PlanChangeSubscription = {
    id,
    product_id: config.paidProducts[plan].eur,
    currency: "eur",
    amount: plan === "starter" ? 3000 : 4800,
    seats: 3,
    customer: { external_id: "forge:workspace:w1" },
    status: "active",
    recurring_interval: "month",
    recurring_interval_count: 1,
    modified_at: start,
    current_period_start: start,
    current_period_end: end,
    past_due_at: null,
    cancel_at_period_end: false,
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    pending_update: null,
  }
  const value = {
    workspaceId: "w1",
    subscriptionId: id,
    billableMembers: 5,
    projectedPlan: plan,
  }
  const context = vi
    .fn()
    .mockImplementation(() => Promise.resolve({ ...value }))
  const orders: Array<UpgradeOrder> = [order()]
  const pending = () => ({
    id: "00000000-0000-4000-8000-000000000097",
    created_at: now.toISOString(),
    modified_at: null,
    applies_at: end,
    product_id: null,
    seats: null,
    units: null,
  })
  const get = vi
    .fn<Client["subscriptions"]["get"]>()
    .mockImplementation(() => Promise.resolve(structuredClone(current)))
  const update = vi
    .fn<Client["subscriptions"]["update"]>()
    .mockImplementation((_id, body) => {
      if ("product_id" in body && body.product_id) {
        if (body.proration_behavior === "next_period")
          current.pending_update = {
            ...(current.pending_update ?? pending()),
            product_id: body.product_id,
          }
        else {
          current.product_id = body.product_id
          current.amount = 4800
          current.pending_update = null
        }
      } else if ("seats" in body) {
        if (body.seats === current.seats) {
          if (current.pending_update?.product_id)
            current.pending_update.seats = null
          else current.pending_update = null
        } else
          current.pending_update = {
            ...(current.pending_update ?? pending()),
            seats: body.seats,
          }
      } else if ("pending_update" in body) current.pending_update = null
      current.modified_at = now.toISOString()
      return Promise.resolve(structuredClone(current))
    })
  const list = vi.fn<Client["orders"]["list"]>().mockImplementation(() =>
    Promise.resolve({
      items: structuredClone(orders),
      pagination: { max_page: 1 },
    })
  )
  const apply = vi.fn().mockImplementation((input) =>
    Promise.resolve({
      outcome: "applied",
      replayed: false,
      effectivePlan:
        input.snapshot.plan === "plus" &&
        (input.snapshot.paidUpgrade || value.projectedPlan === "plus")
          ? "business"
          : "basic",
    })
  )
  return {
    current,
    value,
    context,
    orders,
    get,
    update,
    list,
    apply,
    pending,
    service: new PolarPlanChanger(
      config,
      context,
      {
        subscriptions: { get, update },
        orders: { get: () => Promise.resolve(order()), list },
      },
      apply,
      () => now
    ),
  }
}
describe("paid upgrade evidence", () => {
  it("accepts a paid proration and preserves access after a partial refund", () => {
    expect(verifiedPaidUpgradeOrder(paymentContext, order())?.orderId).toBe(
      orderId
    )
    expect(
      verifiedPaidUpgradeOrder(paymentContext, {
        ...order(),
        status: "partially_refunded",
        refunded_amount: 10,
        refunded_tax_amount: 2,
      })?.orderId
    ).toBe(orderId)
  })
  it.each([
    { paid: false },
    { status: "pending" },
    { status: "refunded" },
    { due_amount: 1 },
    { currency: "usd" },
    { product_id: config.paidProducts.starter.eur },
    { subscription_id: orderId },
    { customer: { external_id: "forge:workspace:foreign" } },
    { billing_reason: "purchase" },
    { refunded_amount: 60, refunded_tax_amount: 12 },
    { refunded_tax_amount: 13 },
    { total_amount: 73 },
    { net_amount: -1 },
    { created_at: "2026-09-30T00:00:00Z" },
    { items: [] },
    { items: [{ ...order().items[0], end_timestamp: "2026-12-01T00:00:00Z" }] },
    { items: [{ ...order().items[1], proration: false }] },
    { items: [{ ...order().items[1], start_timestamp: null }] },
  ] satisfies Array<Partial<UpgradeOrder>>)(
    "does not grant a tier from invalid payment evidence: %j",
    (patch) =>
      expect(
        verifiedPaidUpgradeOrder(paymentContext, { ...order(), ...patch })
      ).toBeNull()
  )
  it("refuses nonboolean provider flags rather than coercing payment evidence", () => {
    expect(
      verifiedPaidUpgradeOrder(paymentContext, {
        ...order(),
        paid: "true" as unknown as boolean,
      })
    ).toBeNull()
    expect(
      verifiedPaidUpgradeOrder(paymentContext, {
        ...order(),
        items: [{ ...order().items[1], proration: 1 as unknown as boolean }],
      })
    ).toBeNull()
  })
  it("uses a paid cycle as proof only for its exact period", () => {
    const cycle = {
      ...order(),
      billing_reason: "subscription_cycle" as const,
      items: [
        { ...order().items[1], proration: false, start_timestamp: start },
      ],
    }
    expect(verifiedPaidUpgradeOrder(paymentContext, cycle)?.orderId).toBe(
      orderId
    )
    expect(
      verifiedPaidUpgradeOrder(paymentContext, {
        ...cycle,
        items: [{ ...cycle.items[0], start_timestamp: now.toISOString() }],
      })
    ).toBeNull()
  })
  it("bounds pagination and treats missing proof as pending", async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [], pagination: { max_page: 10 } })
    expect(
      await findPaidUpgradeOrder({ list, get: vi.fn() }, paymentContext)
    ).toBeUndefined()
    expect(list).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_id: id,
        product_id: config.paidProducts.plus.eur,
        external_customer_id: "forge:workspace:w1",
        page: 3,
      })
    )
  })
})
describe("owner paid-tier changes", () => {
  it("invoices an upgrade now and restores renewal-only seats without moving the current period", async () => {
    const f = fixture()
    f.current.pending_update = { ...f.pending(), seats: 8 }
    expect(await f.service.change(actor, "plus")).toMatchObject({
      target: "plus",
      status: "applied",
      billedSeats: 3,
      renewalSeats: 5,
      effectiveAt: now.toISOString(),
    })
    expect(f.update.mock.calls.map((call) => call[1])).toEqual([
      {
        product_id: config.paidProducts.plus.eur,
        proration_behavior: "invoice",
      },
      { seats: 5, proration_behavior: "next_period" },
    ])
    expect(f.current.seats).toBe(3)
    expect(f.current.current_period_start).toBe(start)
    expect(f.current.current_period_end).toBe(end)
    expect(f.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        snapshot: expect.objectContaining({
          paidUpgrade: expect.objectContaining({ orderId }),
        }),
        planChange: expect.objectContaining({ status: "applied" }),
      })
    )
  })
  it("schedules a downgrade while retaining Plus and any renewal-seat adjustment", async () => {
    const f = fixture("plus")
    f.current.pending_update = { ...f.pending(), seats: 7 }
    expect(await f.service.change(actor, "starter")).toMatchObject({
      status: "scheduled",
      effectiveAt: end,
      billedSeats: 3,
      renewalSeats: 5,
    })
    expect(f.current.product_id).toBe(config.paidProducts.plus.eur)
    expect(f.current.pending_update).toMatchObject({
      product_id: config.paidProducts.starter.eur,
      seats: 5,
    })
    expect(f.update.mock.calls[0][1]).toEqual({
      product_id: config.paidProducts.starter.eur,
      proration_behavior: "next_period",
    })
    expect(
      f.update.mock.calls.every(
        (call) =>
          !("proration_behavior" in call[1]) ||
          call[1].proration_behavior === "next_period"
      )
    ).toBe(true)
  })
  it("retries a paid upgrade without invoicing it again", async () => {
    const f = fixture()
    await f.service.change(actor, "plus")
    await f.service.change(actor, "plus")
    expect(
      f.update.mock.calls.filter((call) => "product_id" in call[1])
    ).toHaveLength(1)
  })
  it("recovers a lost upgrade response by fetching the accepted target before retry", async () => {
    const f = fixture()
    const original = f.update.getMockImplementation()!
    f.update.mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error("lost response")
    })
    await expect(f.service.change(actor, "plus")).rejects.toThrow(
      "lost response"
    )
    expect((await f.service.change(actor, "plus")).status).toBe("unchanged")
    expect(
      f.update.mock.calls.filter((call) => "product_id" in call[1])
    ).toHaveLength(1)
  })
  it("returns pending if payment proof is missing or the locked projection rejects an upgrade", async () => {
    const f = fixture()
    f.orders.length = 0
    expect(await f.service.change(actor, "plus")).toMatchObject({
      status: "payment-pending",
      effectiveAt: null,
    })
    expect(f.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ paidUpgrade: undefined }),
        planChange: expect.objectContaining({ status: "payment-pending" }),
      })
    )
    const raced = fixture()
    raced.apply.mockResolvedValueOnce({
      outcome: "applied",
      replayed: false,
      effectivePlan: "basic",
    })
    expect((await raced.service.change(actor, "plus")).status).toBe(
      "payment-pending"
    )
  })
  it("does not resubmit a failed upgrade during dunning", async () => {
    const f = fixture()
    f.current.product_id = config.paidProducts.plus.eur
    f.current.status = "past_due"
    f.current.past_due_at = now.toISOString()
    f.current.modified_at = now.toISOString()
    f.orders.length = 0
    expect((await f.service.change(actor, "plus")).status).toBe(
      "payment-pending"
    )
    expect(f.update).not.toHaveBeenCalled()
  })
  it("withdraws a pending downgrade and restores its seat schedule", async () => {
    const f = fixture("plus")
    f.current.pending_update = {
      ...f.pending(),
      product_id: config.paidProducts.starter.eur,
      seats: 7,
    }
    expect((await f.service.change(actor, "plus")).status).toBe("cleared")
    expect(f.update.mock.calls.map((call) => call[1])).toEqual([
      { pending_update: null },
      { seats: 5, proration_behavior: "next_period" },
    ])
    expect(f.current.pending_update).toMatchObject({
      product_id: null,
      seats: 5,
    })
  })
  it.each(["member", "guest"])(
    "refuses %s before provider lookup",
    async (role) => {
      const f = fixture()
      await expect(
        f.service.change({ ...actor, workspaceRole: role }, "plus")
      ).rejects.toThrow()
      expect(f.get).not.toHaveBeenCalled()
    }
  )
  it("rechecks live authority before any charge", async () => {
    const f = fixture()
    f.context
      .mockResolvedValueOnce(f.value)
      .mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(f.service.change(actor, "plus")).rejects.toThrow("REVOKED")
    expect(f.update).not.toHaveBeenCalled()
  })
  it("rejects a changed binding or revoked role after the provider read", async () => {
    const f = fixture()
    f.context
      .mockResolvedValueOnce(f.value)
      .mockResolvedValueOnce({ ...f.value, subscriptionId: orderId })
    await expect(f.service.change(actor, "plus")).rejects.toThrow("CONFLICT")
    expect(f.update).not.toHaveBeenCalled()
  })
  it.each([
    { customer: { external_id: "forge:workspace:foreign" } },
    { currency: "usd" },
    { status: "paused" },
    { cancel_at_period_end: true },
    { pause_at_period_end: true },
    { paused_at: now.toISOString() },
    { seats: null },
    {
      pending_update: {
        id: orderId,
        created_at: start,
        modified_at: null,
        applies_at: end,
        product_id: config.paidProducts.plus.eur,
        seats: null,
        units: null,
      },
    },
  ] satisfies Array<Partial<PlanChangeSubscription>>)(
    "refuses an unsupported source without a charge: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.current, patch)
      await expect(f.service.change(actor, "plus")).rejects.toThrow()
      expect(f.update).not.toHaveBeenCalled()
    }
  )
  it("reconciles termination instead of charging a terminal subscription", async () => {
    const f = fixture()
    f.current.status = "unpaid"
    f.current.modified_at = now.toISOString()
    await expect(f.service.change(actor, "plus")).rejects.toThrow("TERMINATED")
    expect(f.update).not.toHaveBeenCalled()
    expect(f.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ terminatedAt: now }),
      })
    )
  })
  it("refuses to confirm a provider that applied downgrade early or moved the period", async () => {
    const early = fixture("plus")
    early.update.mockImplementationOnce(() => {
      early.current.product_id = config.paidProducts.starter.eur
      return Promise.resolve(early.current)
    })
    await expect(early.service.change(actor, "starter")).rejects.toThrow(
      "RECONCILIATION_REQUIRED"
    )
    const moved = fixture()
    const original = moved.update.getMockImplementation()!
    moved.update.mockImplementationOnce(async (...args) => {
      await original(...args)
      moved.current.current_period_end = "2026-12-01T00:00:00Z"
      return moved.current
    })
    await expect(moved.service.change(actor, "plus")).rejects.toThrow(
      "RECONCILIATION_REQUIRED"
    )
  })
})

it("does not withdraw Starter renewal or reuse a refunded upgrade when Plus is requested again", async () => {
  const f = fixture("plus")
  f.context.mockResolvedValue({
    ...f.value,
    projectedPlan: "starter",
    refundedUpgrade: true,
  })
  f.current.pending_update = {
    ...f.pending(),
    product_id: config.paidProducts.starter.eur,
  }
  await expect(f.service.change(actor, "plus")).rejects.toThrow(
    "REFUNDED_UPGRADE_REPURCHASE_REQUIRED"
  )
  expect(f.update).not.toHaveBeenCalled()
})

describe("refund of only a Plus upgrade", () => {
  function refunded(): ProviderRefundOrder {
    return {
      ...order(),
      modified_at: now.toISOString(),
      applied_balance_amount: 0,
      status: "refunded",
      refunded_amount: 60,
      refunded_tax_amount: 12,
      items: order().items.map((item, index) => ({
        ...item,
        tax_amount: index === 0 ? -20 : 32,
      })),
    }
  }
  function basis(): UpgradeOrder {
    return {
      ...order(),
      id: "00000000-0000-4000-8000-000000000097",
      product_id: config.paidProducts.starter.eur,
      billing_reason: "subscription_create",
      created_at: start,
      net_amount: 3000,
      tax_amount: 600,
      total_amount: 3600,
      items: [
        {
          amount: 3000,
          proration: false,
          start_timestamp: start,
          end_timestamp: end,
        },
      ],
    }
  }
  it("verifies full prorated net/tax and a still-paid Starter period", async () => {
    const apply = vi
        .fn()
        .mockResolvedValue({ outcome: "applied", replayed: false }),
      list = vi
        .fn()
        .mockResolvedValue({ items: [basis()], pagination: { max_page: 1 } })
    const service = new PolarSubscriptionRefundReconciler(
      config,
      { orders: { get: () => Promise.resolve(refunded()), list } },
      apply,
      vi.fn().mockResolvedValue({ status: "scheduled" })
    )
    await service.reconcile({
      workspaceId: "w1",
      orderId,
      eventId: "refund",
      bodyHash: "a".repeat(64),
    })
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        refund: expect.objectContaining({
          scope: "upgrade",
          kind: "full",
          starterBasis: { orderId: basis().id, start, end },
        }),
      })
    )
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        product_id: config.paidProducts.starter.eur,
        subscription_id: id,
      })
    )
  })
  it("records restrictive denial before retrying an unavailable or fully refunded base invoice", async () => {
    for (const items of [[], [{ ...basis(), status: "refunded" as const }]]) {
      const apply = vi
        .fn()
        .mockResolvedValue({ outcome: "applied", replayed: false })
      const service = new PolarSubscriptionRefundReconciler(
        config,
        {
          orders: {
            get: () => Promise.resolve(refunded()),
            list: () => Promise.resolve({ items, pagination: { max_page: 1 } }),
          },
        },
        apply,
        vi.fn().mockResolvedValue({ status: "scheduled" })
      )
      await expect(
        service.reconcile({
          workspaceId: "w1",
          orderId,
          eventId: "refund",
          bodyHash: "b".repeat(64),
        })
      ).rejects.toThrow("STARTER_BASE_RECONCILIATION_REQUIRED")
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({
          refund: expect.objectContaining({
            scope: "upgrade",
            starterBasis: undefined,
          }),
        })
      )
    }
  })
  it("does not look for a Starter fallback on a partial upgrade refund", async () => {
    const list = vi.fn(),
      apply = vi
        .fn()
        .mockResolvedValue({ outcome: "unchanged", replayed: false })
    const service = new PolarSubscriptionRefundReconciler(
      config,
      {
        orders: {
          get: () =>
            Promise.resolve({
              ...refunded(),
              status: "partially_refunded",
              refunded_amount: 10,
              refunded_tax_amount: 2,
            }),
          list,
        },
      },
      apply
    )
    await service.reconcile({
      workspaceId: "w1",
      orderId,
      eventId: "partial",
      bodyHash: "c".repeat(64),
    })
    expect(list).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        refund: expect.objectContaining({ kind: "partial", scope: "upgrade" }),
      })
    )
  })
  it("rejects mixed periods and a non-Plus product even when totals are fully refunded", () => {
    expect(() =>
      verifiedPolarPeriodRefund(config, "w1", orderId, {
        ...refunded(),
        product_id: config.paidProducts.starter.eur,
      })
    ).toThrow()
    const mixed = refunded()
    mixed.items[1].end_timestamp = "2026-12-01T00:00:00Z"
    expect(() =>
      verifiedPolarPeriodRefund(config, "w1", orderId, mixed)
    ).toThrow()
  })
})

it("persists unsupported pause proof before refusing a paid product change", async () => {
  const f = fixture()
  f.current.pause_at_period_end = true
  await expect(f.service.change(actor, "plus")).rejects.toThrow(
    "PAUSE_UNSUPPORTED"
  )
  expect(f.update).not.toHaveBeenCalled()
  expect(f.apply).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: expect.objectContaining({ unsupportedPauseAt: new Date(end) }),
    })
  )
})
