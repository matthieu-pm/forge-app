// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { PolarSubscriptionCancellation } from "./polar-subscription-cancellation.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { Actor } from "@/application/actor"

vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture-token",
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
const actor: Actor = {
  workspaceId: "w1",
  userId: "owner",
  workspaceRole: "owner",
  scopes: null,
  authentication: { kind: "session", sessionId: "s" },
}
const id = "00000000-0000-4000-8000-000000000099"
function subscription(): ProviderSubscription {
  return {
    id,
    product_id: config.paidProducts.plus.usd,
    currency: "usd",
    status: "active",
    modified_at: "2026-10-01T00:00:00Z",
    current_period_start: "2026-10-01T00:00:00Z",
    current_period_end: "2026-11-01T00:00:00Z",
    recurring_interval: "month",
    recurring_interval_count: 1,
    past_due_at: null,
    cancel_at_period_end: false,
    ends_at: null,
    ended_at: null,
    customer: { external_id: "forge:workspace:w1" },
  }
}
function setup() {
  let current = subscription()
  const get = vi.fn(() => Promise.resolve(current))
  const update = vi.fn(() => {
    current = {
      ...current,
      cancel_at_period_end: true,
      ends_at: current.current_period_end,
      modified_at: "2026-10-28T00:00:00Z",
    }
    return Promise.resolve(current)
  })
  const context = vi
    .fn()
    .mockResolvedValue({ workspaceId: "w1", subscriptionId: id })
  const apply = vi
    .fn()
    .mockResolvedValue({ outcome: "applied", replayed: false })
  return {
    get,
    update,
    context,
    apply,
    service: new PolarSubscriptionCancellation(
      config,
      context,
      { subscriptions: { get, update } },
      apply
    ),
  }
}
describe("owner cancellation at period end", () => {
  it("recognizes confirmed term-end completion without another provider write", async () => {
    const { service, get, update } = setup()
    get.mockResolvedValue({
      ...subscription(),
      status: "canceled",
      cancel_at_period_end: false,
      ends_at: subscription().current_period_end,
      ended_at: subscription().current_period_end,
    })
    expect((await service.schedule(actor)).status).toBe("canceled")
    expect(update).not.toHaveBeenCalled()
  })
  it("sends only the scheduled-cancel flag and persists confirmed provider state", async () => {
    const { service, context, update, apply } = setup()
    expect(await service.schedule(actor)).toEqual({
      status: "scheduled",
      cancellationEffectiveAt: "2026-11-01T00:00:00.000Z",
    })
    expect(context).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith(id, { cancel_at_period_end: true })
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        snapshot: expect.objectContaining({
          cancelAtPeriodEnd: true,
          currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
        }),
      })
    )
    await service.schedule(actor)
    expect(update).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...actor, workspaceRole: "member" },
    {
      ...actor,
      authentication: { kind: "apiKey" as const, credentialId: "key" },
    },
  ])("requires a first-party owner/admin before lookup", async (candidate) => {
    const { service, get } = setup()
    await expect(service.schedule(candidate)).rejects.toThrow()
    expect(get).not.toHaveBeenCalled()
  })
  it("rechecks revoked authority and changed binding before the provider write", async () => {
    const first = setup()
    first.context
      .mockResolvedValueOnce({ workspaceId: "w1", subscriptionId: id })
      .mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(first.service.schedule(actor)).rejects.toThrow("REVOKED")
    expect(first.update).not.toHaveBeenCalled()
    const second = setup()
    second.context
      .mockResolvedValueOnce({ workspaceId: "w1", subscriptionId: id })
      .mockResolvedValueOnce({
        workspaceId: "w1",
        subscriptionId: "00000000-0000-4000-8000-000000000098",
      })
    await expect(second.service.schedule(actor)).rejects.toThrow("CONFLICT")
    expect(second.update).not.toHaveBeenCalled()
  })
  it("does not confirm a schedule that the provider did not apply", async () => {
    const { service, update, apply } = setup()
    update.mockImplementationOnce(() => Promise.resolve(subscription()))
    await expect(service.schedule(actor)).rejects.toThrow("NOT_CONFIRMED")
    expect(apply).not.toHaveBeenCalled()
  })
  it("recovers a timeout after the provider accepted cancellation without writing again", async () => {
    const { service, get, update } = setup()
    update.mockRejectedValueOnce(new Error("timeout"))
    await expect(service.schedule(actor)).rejects.toThrow("timeout")
    get.mockResolvedValue({
      ...subscription(),
      cancel_at_period_end: true,
      ends_at: subscription().current_period_end,
      modified_at: "2026-10-28T00:00:00Z",
    })
    expect((await service.schedule(actor)).status).toBe("scheduled")
    expect(update).toHaveBeenCalledTimes(1)
  })
  it("rejects customer mismatch and an unexpected moved cancellation boundary", async () => {
    const first = setup()
    first.get.mockResolvedValueOnce({
      ...subscription(),
      customer: { external_id: "forge:workspace:w2" },
    })
    await expect(first.service.schedule(actor)).rejects.toThrow(
      "IDENTITY_MISMATCH"
    )
    expect(first.update).not.toHaveBeenCalled()
    const second = setup()
    second.get.mockResolvedValueOnce(subscription()).mockResolvedValueOnce({
      ...subscription(),
      cancel_at_period_end: true,
      ends_at: "2026-12-01T00:00:00Z",
      current_period_end: "2026-12-01T00:00:00Z",
    })
    await expect(second.service.schedule(actor)).rejects.toThrow(
      "NOT_CONFIRMED"
    )
    expect(second.apply).not.toHaveBeenCalled()
  })
})
