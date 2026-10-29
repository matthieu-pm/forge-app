// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { PolarRenewalCurrencyPlanner } from "./polar-renewal-currency.server"
import type { CurrencyChangeSubscription } from "./polar-renewal-currency.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { Actor } from "@/application/actor"

vi.mock("./renewal-currency-request.server", () => ({
  recordVerifiedRenewalCurrencyRequest: vi.fn(),
}))
vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
vi.mock("./subscription-refund.server", () => ({
  applyVerifiedPeriodRefund: vi.fn(),
}))
const id = "00000000-0000-4000-8000-000000000099",
  requestId = "00000000-0000-4000-8000-000000000098"
const start = "2026-10-01T00:00:00Z",
  end = "2026-11-01T00:00:00Z",
  now = new Date("2026-10-29T00:00:00Z")
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
  const current: CurrencyChangeSubscription = {
    id,
    product_id: config.paidProducts.plus.usd,
    currency: "usd",
    status: "active",
    customer: {
      external_id: "forge:workspace:w1",
      billing_address: { country: "FR" },
    },
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
  const context = {
    workspaceId: "w1",
    subscriptionId: id,
    projectedPlan: "plus" as const,
    billableMembers: 5,
  }
  const resolve = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ ...context })),
    get = vi
      .fn()
      .mockImplementation(() => Promise.resolve(structuredClone(current))),
    record = vi.fn().mockResolvedValue({
      status: "requires-checkout",
      providerChangeScheduled: false,
    })
  const project = vi.fn().mockResolvedValue({
    outcome: "applied",
    replayed: false,
    effectivePlan: "free",
  })
  return {
    project,
    current,
    resolve,
    get,
    record,
    service: new PolarRenewalCurrencyPlanner(
      config,
      resolve,
      get,
      record,
      () => now,
      project
    ),
  }
}
describe("renewal currency request boundary", () => {
  it("projects verified pause/termination restrictions before refusing a request", async () => {
    const f = fixture()
    f.current.pause_at_period_end = true
    await expect(f.service.request(actor, requestId)).rejects.toThrow(
      "NOT_RENEWING"
    )
    expect(f.project).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          unsupportedPauseAt: new Date(end),
        }),
      })
    )
    expect(f.record).not.toHaveBeenCalled()
  })

  it("uses the provider-confirmed country and source currency without a provider mutation or success claim", async () => {
    const f = fixture()
    expect(await f.service.request(actor, requestId)).toMatchObject({
      status: "requires-checkout",
      providerChangeScheduled: false,
    })
    expect(f.get).toHaveBeenCalledExactlyOnceWith(id)
    expect(f.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        requestId,
        billingCountry: "FR",
        fromCurrency: "usd",
        currentPlan: "plus",
        renewalPlan: "plus",
        periodEnd: new Date(end),
      })
    )
  })
  it("composes an approved pending Starter downgrade and membership changes for renewal", async () => {
    const f = fixture()
    f.current.pending_update = {
      id: requestId,
      created_at: start,
      modified_at: null,
      applies_at: end,
      product_id: config.paidProducts.starter.usd,
      seats: 7,
      units: null,
    }
    await f.service.request(actor, requestId)
    expect(f.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ renewalPlan: "starter" })
    )
  })
  it.each([
    {
      customer: {
        external_id: "forge:workspace:other",
        billing_address: { country: "FR" },
      },
    },
    { customer: { external_id: "forge:workspace:w1", billing_address: null } },
    {
      customer: {
        external_id: "forge:workspace:w1",
        billing_address: { country: "ZZ" },
      },
    },
    { product_id: id },
    { currency: "eur" },
    { cancel_at_period_end: true },
    { pause_at_period_end: true },
    { status: "past_due", past_due_at: start },
    { current_period_end: start },
  ] satisfies Array<Partial<CurrencyChangeSubscription>>)(
    "refuses unsupported source data before recording: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.current, patch)
      await expect(f.service.request(actor, requestId)).rejects.toThrow()
      expect(f.record).not.toHaveBeenCalled()
    }
  )
  it("checks live authority/binding again after fetching provider state", async () => {
    const f = fixture()
    f.resolve
      .mockResolvedValueOnce({
        workspaceId: "w1",
        subscriptionId: id,
        projectedPlan: "plus",
        billableMembers: 5,
      })
      .mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(f.service.request(actor, requestId)).rejects.toThrow("REVOKED")
    expect(f.record).not.toHaveBeenCalled()
  })
  it("rejects ordinary-member and API-key actors before provider reads", async () => {
    const f = fixture()
    await expect(
      f.service.request({ ...actor, workspaceRole: "member" }, requestId)
    ).rejects.toThrow()
    expect(f.get).not.toHaveBeenCalled()
    await expect(
      f.service.request(
        {
          ...actor,
          authentication: { kind: "apiKey", credentialId: "fixture" },
        },
        requestId
      )
    ).rejects.toThrow()
    expect(f.get).not.toHaveBeenCalled()
  })
})
