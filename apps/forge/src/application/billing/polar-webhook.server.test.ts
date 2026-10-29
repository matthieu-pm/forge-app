// @vitest-environment node
import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { handlePolarWebhook } from "./polar-webhook.server"
import {
  PolarSubscriptionReconciler,
  verifiedPolarSubscriptionSnapshot,
} from "./polar-subscription-reconciliation.server"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { EnabledBillingConfig } from "./billing-config.server"

vi.mock("./subscription-refund.server", () => ({
  applyVerifiedPeriodRefund: vi.fn(),
}))

vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))

const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture-token",
  webhookSecret: "fixture-webhook-secret",
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
const id = "00000000-0000-4000-8000-000000000099"
function signed(
  body = JSON.stringify({
    type: "subscription.past_due",
    data: { id, customer: { external_id: "forge:workspace:w1" } },
  }),
  timestamp = Math.floor(Date.now() / 1000)
) {
  const eventId = "event-fixture"
  const signature = createHmac("sha256", config.webhookSecret)
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64")
  return new Request("http://localhost:3000/api/billing/polar/webhook", {
    method: "POST",
    headers: {
      "webhook-id": eventId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    },
    body,
  })
}
function subscription(): ProviderSubscription {
  return {
    id,
    product_id: config.paidProducts.plus.usd,
    currency: "usd",
    customer: { external_id: "forge:workspace:w1" },
    status: "past_due",
    recurring_interval: "month",
    recurring_interval_count: 1,
    cancel_at_period_end: false,
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    modified_at: "2026-10-28T01:00:00Z",
    past_due_at: "2026-10-25T01:00:00Z",
    current_period_start: "2026-10-25T01:00:00Z",
    current_period_end: "2026-11-25T01:00:00Z",
  }
}

describe("Polar signed webhook boundary", () => {
  it("uses verified creation time for an initial subscription whose modified_at is null", () => {
    const initial = {
      ...subscription(),
      status: "active" as const,
      past_due_at: null,
      modified_at: null,
      created_at: "2026-10-25T01:00:00Z",
    }
    expect(
      verifiedPolarSubscriptionSnapshot(config, "w1", id, initial).updatedAt
    ).toEqual(new Date(initial.created_at))
    expect(
      verifiedPolarSubscriptionSnapshot(config, "w1", id, {
        ...initial,
        modified_at: "2026-10-28T01:00:00Z",
      }).updatedAt
    ).toEqual(new Date("2026-10-28T01:00:00Z"))
    expect(() =>
      verifiedPolarSubscriptionSnapshot(config, "w1", id, {
        ...initial,
        created_at: "invalid",
      })
    ).toThrow()
  })
  it("verifies the exact bytes and forwards only trusted identity and a digest", async () => {
    const reconcile = vi.fn().mockResolvedValue({})
    expect(
      (await handlePolarWebhook(signed(), config, { reconcile })).status
    ).toBe(200)
    expect(reconcile).toHaveBeenCalledWith({
      workspaceId: "w1",
      subscriptionId: id,
      eventId: "event-fixture",
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })
  it("rejects altered bytes, missing signatures and old timestamps before provider calls", async () => {
    const reconcile = vi.fn()
    const valid = signed()
    const tampered = new Request(valid.url, {
      method: "POST",
      headers: valid.headers,
      body: (await valid.text()) + " ",
    })
    for (const request of [
      tampered,
      new Request(valid.url, { method: "POST", body: "{}" }),
      signed(undefined, Math.floor(Date.now() / 1000) - 600),
    ]) {
      expect(
        (await handlePolarWebhook(request, config, { reconcile })).status
      ).toBe(400)
    }
    expect(reconcile).not.toHaveBeenCalled()
  })
  it("keeps disabled billing unavailable and bounds unsigned request bodies", async () => {
    expect(
      (await handlePolarWebhook(signed(), { enabled: false })).status
    ).toBe(404)
    expect(
      (await handlePolarWebhook(signed(" ".repeat(1_048_577)), config)).status
    ).toBe(413)
  })
  it("rejects signed malformed identities and leaves unimplemented event policy unavailable", async () => {
    const reconcile = vi.fn()
    const wrong = signed(
      JSON.stringify({
        type: "subscription.active",
        data: { id, customer: { external_id: "user-id" } },
      })
    )
    expect(
      (await handlePolarWebhook(wrong, config, { reconcile })).status
    ).toBe(400)
    expect(
      (
        await handlePolarWebhook(
          signed(
            JSON.stringify({ type: "subscription.revoked", data: { id } })
          ),
          config,
          { reconcile }
        )
      ).status
    ).toBe(503)
    expect(reconcile).not.toHaveBeenCalled()
  })
  it("redacts provider errors without acknowledging uncommitted reconciliation", async () => {
    const reconcile = vi
      .fn()
      .mockRejectedValue(new Error("private token and SQL"))
    const response = await handlePolarWebhook(signed(), config, { reconcile })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("private")
  })
})

describe("Polar authoritative subscription reconciliation", () => {
  it("fetches current provider state rather than projecting webhook status", async () => {
    const get = vi.fn().mockResolvedValue(subscription()),
      apply = vi.fn().mockResolvedValue({ outcome: "applied", replayed: false })
    const service = new PolarSubscriptionReconciler(
      config,
      { subscriptions: { get } },
      apply
    )
    await service.reconcile({
      workspaceId: "w1",
      subscriptionId: id,
      eventId: "e",
      bodyHash: "a".repeat(64),
    })
    expect(get).toHaveBeenCalledWith(id)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          plan: "plus",
          status: "past_due",
          pastDueAt: new Date("2026-10-25T01:00:00Z"),
        }),
      })
    )
  })
  it.each([
    { status: "unpaid" as const, ended_at: null },
    { status: "canceled" as const, ended_at: "2026-10-27T00:00:00Z" },
    { status: "canceled" as const, ended_at: null },
    {
      status: "canceled" as const,
      cancel_at_period_end: true,
      ended_at: "2026-10-27T00:00:00Z",
      ends_at: "2026-10-27T00:00:00Z",
    },
  ])("verifies terminal provider state independently of grace: %j", (patch) => {
    const snapshot = verifiedPolarSubscriptionSnapshot(config, "w1", id, {
      ...subscription(),
      ...patch,
    })
    expect(snapshot).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: false,
      terminatedAt: expect.any(Date),
    })
    expect(snapshot.pastDueAt).toBeNull()
  })
  it("keeps scheduled cancellation nonterminal until the provider actually ends it", () => {
    expect(
      verifiedPolarSubscriptionSnapshot(config, "w1", id, {
        ...subscription(),
        status: "canceled",
        cancel_at_period_end: true,
        ended_at: null,
      })
    ).toMatchObject({ cancelAtPeriodEnd: true, terminatedAt: null })
  })
  it("dispatches a signed revoked event but fetches current provider proof", async () => {
    const get = vi
        .fn()
        .mockResolvedValue({ ...subscription(), status: "unpaid" }),
      apply = vi.fn().mockResolvedValue({ outcome: "applied", replayed: false })
    const service = new PolarSubscriptionReconciler(
      config,
      { subscriptions: { get } },
      apply
    )
    expect(
      (
        await handlePolarWebhook(
          signed(
            JSON.stringify({
              type: "subscription.revoked",
              data: { id, customer: { external_id: "forge:workspace:w1" } },
            })
          ),
          config,
          service
        )
      ).status
    ).toBe(200)
    expect(get).toHaveBeenCalledWith(id)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          terminatedAt: new Date("2026-10-28T01:00:00Z"),
        }),
      })
    )
  })
  it.each([
    { customer: { external_id: "forge:workspace:w2" } },
    { id: "wrong" },
    { product_id: "unapproved-product" },
    { currency: "eur" },
    { recurring_interval: "year" },
    { status: "incomplete" },
    { status: "paused" },
    { status: "active", ended_at: "2026-10-27T00:00:00Z" },
    { status: "unpaid", ended_at: "2026-10-29T00:00:00Z" },
    { past_due_at: null },
    { modified_at: null },
  ])(
    "rejects mismatched, unpaid or incomplete provider state: %j",
    async (patch) => {
      const apply = vi.fn()
      const service = new PolarSubscriptionReconciler(
        config,
        {
          subscriptions: {
            get: vi.fn().mockResolvedValue({ ...subscription(), ...patch }),
          },
        },
        apply
      )
      await expect(
        service.reconcile({
          workspaceId: "w1",
          subscriptionId: id,
          eventId: "e",
          bodyHash: "a".repeat(64),
        })
      ).rejects.toThrow()
      expect(apply).not.toHaveBeenCalled()
    }
  )
})

describe("unsupported provider pauses at launch", () => {
  it.each(["subscription.paused", "subscription.resumed"])(
    "re-fetches current state for signed %s instead of trusting a resumed event",
    async (type) => {
      const current = {
        ...subscription(),
        status: "paused" as const,
        past_due_at: null,
        paused_at: "2026-10-27T00:00:00Z",
        resumes_at: "2026-11-01T00:00:00Z",
      }
      const get = vi.fn().mockResolvedValue(current),
        list = vi.fn(),
        apply = vi.fn().mockResolvedValue({})
      const service = new PolarSubscriptionReconciler(
        config,
        { subscriptions: { get }, orders: { get: vi.fn(), list } },
        apply
      )
      const body = JSON.stringify({
        type,
        data: {
          id,
          customer: { external_id: "forge:workspace:w1" },
          paused_at: null,
          status: "active",
        },
      })
      expect(
        (await handlePolarWebhook(signed(body), config, service)).status
      ).toBe(200)
      expect(get).toHaveBeenCalledWith(id)
      expect(list).not.toHaveBeenCalled()
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            unsupportedPauseAt: new Date(current.paused_at),
          }),
        })
      )
    }
  )
  it("records the original period end for a scheduled pause without minting paid proof", async () => {
    const current = {
      ...subscription(),
      status: "active" as const,
      past_due_at: null,
      pause_at_period_end: true,
    }
    expect(
      verifiedPolarSubscriptionSnapshot(config, "w1", id, current)
        .unsupportedPauseAt
    ).toEqual(new Date(current.current_period_end))
    const apply = vi.fn(),
      list = vi.fn()
    await new PolarSubscriptionReconciler(
      config,
      {
        subscriptions: { get: () => Promise.resolve(current) },
        orders: { get: vi.fn(), list },
      },
      apply
    ).reconcile({
      workspaceId: "w1",
      subscriptionId: id,
      eventId: "pause",
      bodyHash: "a".repeat(64),
    })
    expect(list).not.toHaveBeenCalled()
  })
  it.each([
    { paused_at: "2026-10-29T00:00:00Z" },
    { resumes_at: "2026-11-01T00:00:00Z" },
    { paused_at: "2026-10-27T00:00:00Z", resumes_at: "2026-10-26T00:00:00Z" },
    { pause_at_period_end: undefined },
    { paused_at: undefined },
    { resumes_at: undefined },
  ])("refuses incomplete or contradictory pause evidence: %j", (patch) => {
    expect(() =>
      verifiedPolarSubscriptionSnapshot(config, "w1", id, {
        ...subscription(),
        ...patch,
      } as ProviderSubscription)
    ).toThrow()
  })
})

it("does not grant from an active resumed subscription when the pause delivery was missed", async () => {
  const current = {
    ...subscription(),
    status: "active" as const,
    past_due_at: null,
  }
  const apply = vi.fn(),
    list = vi.fn()
  const service = new PolarSubscriptionReconciler(
    config,
    {
      subscriptions: { get: () => Promise.resolve(current) },
      orders: { get: vi.fn(), list },
    },
    apply
  )
  expect(
    (
      await handlePolarWebhook(
        signed(
          JSON.stringify({
            type: "subscription.resumed",
            data: { id, customer: current.customer },
          })
        ),
        config,
        service
      )
    ).status
  ).toBe(200)
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: expect.objectContaining({
        unsupportedPauseAt: new Date(current.modified_at!),
      }),
    })
  )
  expect(list).not.toHaveBeenCalled()
})
