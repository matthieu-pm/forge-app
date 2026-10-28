// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { PolarUpgradeRefundRenewal } from "./polar-upgrade-refund-renewal.server"
import { PolarSubscriptionRefundReconciler } from "./polar-subscription-refund.server"
import type { PlanChangeSubscription } from "./polar-plan-change.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { ProviderRefundOrder } from "./polar-subscription-refund.server"

vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
vi.mock("./subscription-refund.server", () => ({
  applyVerifiedPeriodRefund: vi.fn(),
}))
const id = "00000000-0000-4000-8000-000000000099",
  orderId = "00000000-0000-4000-8000-000000000098"
const start = "2026-10-01T00:00:00.000Z",
  end = "2026-11-01T00:00:00.000Z",
  now = new Date("2026-10-29T00:00:00Z")
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture",
  webhookSecret: "fixture",
  appUrl: "https://forge.test",
  paidProducts: {
    starter: {
      eur: "00000000-0000-4000-8000-000000000001",
      usd: "00000000-0000-4000-8000-000000000002",
    },
    plus: {
      eur: "00000000-0000-4000-8000-000000000003",
      usd: "00000000-0000-4000-8000-000000000004",
    },
  },
}
const identity = {
  workspaceId: "w1",
  environment: "sandbox" as const,
  subscriptionId: id,
  orderId,
}
function fixture() {
  const current: PlanChangeSubscription = {
    id,
    product_id: config.paidProducts.plus.eur,
    currency: "eur",
    amount: 4800,
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
    pending_update: {
      id: orderId,
      created_at: start,
      modified_at: start,
      applies_at: end,
      product_id: null,
      seats: 5,
      units: null,
    },
  }
  type Store = NonNullable<
    ConstructorParameters<typeof PolarUpgradeRefundRenewal>[2]
  >
  const read = vi.fn<Store["read"]>().mockResolvedValue({
    status: "required",
    start,
    end,
    revision: "a".repeat(64),
  })
  const confirm = vi
    .fn<Store["confirm"]>()
    .mockResolvedValue({ status: "scheduled", replayed: false })
  const project = vi.fn<Store["project"]>().mockResolvedValue({
    outcome: "applied",
    replayed: false,
    effectivePlan: "free",
  })
  const get = vi
    .fn()
    .mockImplementation(() => Promise.resolve(structuredClone(current)))
  const update = vi.fn().mockImplementation((_id, body) => {
    current.pending_update!.product_id = body.product_id
    current.modified_at = now.toISOString()
    return Promise.resolve(structuredClone(current))
  })
  return {
    current,
    read,
    confirm,
    project,
    get,
    update,
    service: new PolarUpgradeRefundRenewal(
      config,
      { get, update },
      { read, confirm, project },
      () => now
    ),
  }
}
describe("Starter renewal after a refunded Plus upgrade", () => {
  it("schedules only the product in the same currency and preserves billed and pending seats", async () => {
    const f = fixture()
    expect(await f.service.reconcile(identity)).toMatchObject({
      status: "scheduled",
    })
    expect(f.update).toHaveBeenCalledExactlyOnceWith(id, {
      product_id: config.paidProducts.starter.eur,
      proration_behavior: "next_period",
    })
    expect(f.confirm).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        effectiveAt: end,
        billedSeats: 3,
        renewalSeats: 5,
        currency: "eur",
        status: "scheduled",
      })
    )
    await f.service.reconcile(identity)
    expect(f.update).toHaveBeenCalledTimes(1)
  })
  it("recovers an accepted update with a lost response without another provider write", async () => {
    const f = fixture(),
      update = f.update.getMockImplementation()!
    f.update.mockImplementationOnce(async (...args) => {
      await update(...args)
      throw new Error("network timeout")
    })
    await expect(f.service.reconcile(identity)).rejects.toThrow(
      "network timeout"
    )
    expect(f.confirm).not.toHaveBeenCalled()
    await f.service.reconcile(identity)
    expect(f.update).toHaveBeenCalledTimes(1)
  })
  it("retries confirmation after audit failure without rescheduling", async () => {
    const f = fixture()
    f.confirm.mockRejectedValueOnce(new Error("audit unavailable"))
    await expect(f.service.reconcile(identity)).rejects.toThrow(
      "audit unavailable"
    )
    await f.service.reconcile(identity)
    expect(f.update).toHaveBeenCalledTimes(1)
    expect(f.confirm).toHaveBeenCalledTimes(2)
  })
  it("does not mutate a subscription already on Starter", async () => {
    const f = fixture()
    f.current.product_id = config.paidProducts.starter.eur
    await f.service.reconcile(identity)
    expect(f.update).not.toHaveBeenCalled()
    expect(f.confirm).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ status: "already-starter" })
    )
  })
  it("can schedule during past-due without changing grace or collecting payment", async () => {
    const f = fixture()
    f.current.status = "past_due"
    f.current.past_due_at = now.toISOString()
    await f.service.reconcile(identity)
    expect(f.update).toHaveBeenCalledExactlyOnceWith(id, {
      product_id: config.paidProducts.starter.eur,
      proration_behavior: "next_period",
    })
  })
  it.each([
    { customer: { external_id: "forge:workspace:other" } },
    { currency: "usd" },
    { seats: 0 },
    { status: "trialing" },
    { cancel_at_period_end: true },
    { pause_at_period_end: true },
    { current_period_end: "2026-12-01T00:00:00Z" },
  ] satisfies Array<Partial<PlanChangeSubscription>>)(
    "refuses unsupported provider state before writes: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.current, patch)
      await expect(f.service.reconcile(identity)).rejects.toThrow()
      expect(f.update).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
    }
  )
  it("does not overwrite a conflicting pending product, units or date", async () => {
    for (const patch of [
      { product_id: id },
      { units: 1 },
      { applies_at: start },
    ]) {
      const f = fixture()
      Object.assign(f.current.pending_update!, patch)
      await expect(f.service.reconcile(identity)).rejects.toThrow(
        "PENDING_CHANGE_CONFLICT"
      )
      expect(f.update).not.toHaveBeenCalled()
    }
  })
  it.each(["amount", "seats", "current_period_end"] as const)(
    "does not confirm an unexpected immediate change to %s",
    async (field) => {
      const f = fixture(),
        update = f.update.getMockImplementation()!
      f.update.mockImplementationOnce(async (...args) => {
        await update(...args)
        if (field === "current_period_end")
          f.current.current_period_end = "2026-12-01T00:00:00Z"
        else f.current[field] = 999
        return f.current
      })
      await expect(f.service.reconcile(identity)).rejects.toThrow()
      expect(f.confirm).not.toHaveBeenCalled()
    }
  )
  it("stops when the grant is superseded or the binding changes before a provider write", async () => {
    const f = fixture()
    f.read
      .mockResolvedValueOnce({
        status: "required",
        start,
        end,
        revision: "a".repeat(64),
      })
      .mockResolvedValue({ status: "superseded" })
    expect(await f.service.reconcile(identity)).toMatchObject({
      status: "superseded",
    })
    expect(f.update).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it("projects terminal provider proof and never uncancels or restores the subscription", async () => {
    const f = fixture()
    f.current.status = "unpaid"
    f.current.modified_at = now.toISOString()
    expect(await f.service.reconcile(identity)).toMatchObject({
      status: "terminated",
    })
    expect(f.project).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ terminatedAt: now }),
      })
    )
    expect(f.update).not.toHaveBeenCalled()
  })
  it("persists access revocation before scheduling; failure keeps the webhook retryable even without base proof", async () => {
    const f = fixture(),
      apply = vi.fn().mockResolvedValue({ outcome: "applied", replayed: false })
    const renewal = vi.fn().mockImplementation(() => {
      expect(apply).toHaveBeenCalledOnce()
      return Promise.reject(new Error("schedule unavailable"))
    })
    const order: ProviderRefundOrder = {
      id: orderId,
      status: "refunded",
      net_amount: 60,
      tax_amount: 0,
      total_amount: 60,
      refunded_amount: 60,
      refunded_tax_amount: 0,
      applied_balance_amount: 0,
      billing_reason: "subscription_update",
      currency: "eur",
      product_id: config.paidProducts.plus.eur,
      subscription_id: id,
      modified_at: now.toISOString(),
      customer: f.current.customer,
      items: [
        {
          amount: 60,
          tax_amount: 0,
          proration: true,
          start_timestamp: now.toISOString(),
          end_timestamp: end,
        },
      ],
    }
    const service = new PolarSubscriptionRefundReconciler(
      config,
      { orders: { get: () => Promise.resolve(order) } },
      apply,
      renewal
    )
    await expect(
      service.reconcile({
        workspaceId: "w1",
        orderId,
        eventId: "refund",
        bodyHash: "b".repeat(64),
      })
    ).rejects.toThrow("schedule unavailable")
    expect(renewal).toHaveBeenCalledWith(identity)
  })
})
