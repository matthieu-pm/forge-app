// @vitest-environment node
import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { handlePolarWebhook } from "./polar-webhook.server"
import { PolarSubscriptionReconciler } from "./polar-subscription-reconciliation.server"
import type { EnabledBillingConfig } from "./billing-config.server"

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
function subscription() {
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
    modified_at: "2026-10-28T01:00:00Z",
    past_due_at: "2026-10-25T01:00:00Z",
    current_period_start: "2026-10-25T01:00:00Z",
    current_period_end: "2026-11-25T01:00:00Z",
  }
}

describe("Polar signed webhook boundary", () => {
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
    { customer: { external_id: "forge:workspace:w2" } },
    { id: "wrong" },
    { product_id: "unapproved-product" },
    { currency: "eur" },
    { recurring_interval: "year" },
    { status: "incomplete" },
    { status: "canceled" },
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
