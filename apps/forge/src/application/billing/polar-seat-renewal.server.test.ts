// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { PolarSeatRenewalScheduler } from "./polar-seat-renewal.server"
import type { Actor } from "@/application/actor"
import type { EnabledBillingConfig } from "./billing-config.server"

type Client = NonNullable<
  ConstructorParameters<typeof PolarSeatRenewalScheduler>[2]
>
type Snapshot = Awaited<ReturnType<Client["subscriptions"]["get"]>>
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture-token",
  webhookSecret: "fixture-secret",
  appUrl: "https://forge.test",
  paidProducts: {
    starter: { eur: "starter-eur", usd: "starter-usd" },
    plus: { eur: "plus-eur", usd: "plus-usd" },
  },
}
const actor: Actor = {
  userId: "alice",
  workspaceId: "workspace-a",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "s" },
  scopes: null,
}
const subscriptionId = "00000000-0000-4000-8000-000000000001"
const start = "2026-10-10T12:00:00.000Z"
const end = "2026-11-10T12:00:00.000Z"
const now = new Date("2026-10-28T12:00:00Z")
function pending(seats: number): NonNullable<Snapshot["pending_update"]> {
  return {
    id: "pending",
    created_at: now.toISOString(),
    modified_at: null,
    applies_at: end,
    product_id: null,
    units: null,
    seats,
  }
}
function fixture() {
  const snapshot: Snapshot = {
    id: subscriptionId,
    customer: { external_id: "forge:workspace:workspace-a" },
    amount: 3000,
    seats: 3,
    currency: "eur",
    product_id: "starter-eur",
    recurring_interval: "month",
    recurring_interval_count: 1,
    current_period_start: start,
    current_period_end: end,
    status: "active",
    cancel_at_period_end: false,
    pause_at_period_end: false,
    paused_at: null,
    ends_at: null,
    ended_at: null,
    pending_update: null,
  }
  const context = vi.fn().mockResolvedValue({
    workspaceId: "workspace-a",
    subscriptionId,
    billableMembers: 5,
  })
  const get = vi
    .fn<Client["subscriptions"]["get"]>()
    .mockImplementation(() => Promise.resolve(structuredClone(snapshot)))
  const update = vi
    .fn<Client["subscriptions"]["update"]>()
    .mockImplementation((_id, body) => {
      if (!("seats" in body)) throw new Error("Expected seat update")
      snapshot.pending_update =
        body.seats === snapshot.seats ? null : pending(body.seats)
      return Promise.resolve(structuredClone(snapshot))
    })
  const clock = vi.fn(() => now)
  return {
    snapshot,
    context,
    get,
    update,
    clock,
    scheduler: new PolarSeatRenewalScheduler(
      config,
      context,
      { subscriptions: { get, update } },
      clock
    ),
  }
}

describe("renewal-only workspace seat changes", () => {
  it.each([1, 5])(
    "schedules %i members at renewal, preserving current billed seats and amount",
    async (members) => {
      const f = fixture()
      f.context.mockResolvedValueOnce({
        workspaceId: actor.workspaceId,
        subscriptionId,
        billableMembers: members,
      })
      expect(await f.scheduler.schedule(actor)).toEqual({
        status: "scheduled",
        billedSeats: 3,
        renewalSeats: members,
        effectiveAt: end,
      })
      expect(f.update).toHaveBeenCalledExactlyOnceWith(subscriptionId, {
        seats: members,
        proration_behavior: "next_period",
      })
      expect(f.snapshot.seats).toBe(3)
      expect(f.snapshot.amount).toBe(3000)
    }
  )

  it("retries a confirmed schedule without a second write", async () => {
    const f = fixture()
    await f.scheduler.schedule(actor)
    expect(await f.scheduler.schedule(actor)).toMatchObject({
      status: "unchanged",
      billedSeats: 3,
      renewalSeats: 5,
    })
    expect(f.update).toHaveBeenCalledTimes(1)
  })

  it("replaces an earlier seat schedule with the latest membership", async () => {
    const f = fixture()
    f.snapshot.pending_update = pending(8)
    expect(await f.scheduler.schedule(actor)).toMatchObject({
      status: "scheduled",
      renewalSeats: 5,
    })
    expect(f.snapshot.pending_update.seats).toBe(5)
  })

  it("withdraws a scheduled change when membership returns to the billed quantity", async () => {
    const f = fixture()
    f.snapshot.pending_update = pending(8)
    f.context.mockResolvedValueOnce({
      workspaceId: actor.workspaceId,
      subscriptionId,
      billableMembers: 3,
    })
    expect(await f.scheduler.schedule(actor)).toMatchObject({
      status: "cleared",
      billedSeats: 3,
      renewalSeats: 3,
    })
    expect(f.update).toHaveBeenCalledExactlyOnceWith(subscriptionId, {
      seats: 3,
      proration_behavior: "next_period",
    })
    expect(f.snapshot.pending_update).toBeNull()
  })

  it("does nothing when current billed seats already match membership", async () => {
    const f = fixture()
    f.snapshot.seats = 5
    expect(await f.scheduler.schedule(actor)).toMatchObject({
      status: "unchanged",
    })
    expect(f.update).not.toHaveBeenCalled()
  })

  it("denies ordinary members before reading context or contacting Polar", async () => {
    const f = fixture()
    await expect(
      f.scheduler.schedule({ ...actor, workspaceRole: "member" })
    ).rejects.toThrow()
    expect(f.context).not.toHaveBeenCalled()
    expect(f.get).not.toHaveBeenCalled()
  })

  it("rejects cross-workspace context and invalid member counts before Polar", async () => {
    const f = fixture()
    for (const [workspaceId, members] of [
      ["workspace-b", 5],
      [actor.workspaceId, 0],
      [actor.workspaceId, -1],
      [actor.workspaceId, 1.5],
    ] as const) {
      f.context.mockResolvedValueOnce({
        workspaceId,
        subscriptionId,
        billableMembers: members,
      })
      await expect(f.scheduler.schedule(actor)).rejects.toThrow()
    }
    expect(f.get).not.toHaveBeenCalled()
  })

  it.each([
    { customer: { external_id: "forge:workspace:another" } },
    { id: "another-subscription" },
    { product_id: "unapproved-product" },
    { currency: "usd" },
    { recurring_interval_count: 12 },
    { status: "past_due" },
    { status: "trialing" },
    { cancel_at_period_end: true },
    { pause_at_period_end: true },
    { ended_at: start },
    { seats: null },
    { current_period_end: now.toISOString() },
    { current_period_start: end },
  ] satisfies Array<Partial<Snapshot>>)(
    "requires reconciliation for invalid or unsupported provider state: %j",
    async (patch) => {
      const f = fixture()
      Object.assign(f.snapshot, patch)
      await expect(f.scheduler.schedule(actor)).rejects.toThrow()
      expect(f.update).not.toHaveBeenCalled()
    }
  )

  it.each([
    { product_id: "plus-eur" },
    { units: 2 },
    { applies_at: start },
    { seats: null },
  ])("refuses a conflicting pending change: %j", async (patch) => {
    const f = fixture()
    f.snapshot.pending_update = { ...pending(8), ...patch }
    await expect(f.scheduler.schedule(actor)).rejects.toThrow("conflicting")
    expect(f.update).not.toHaveBeenCalled()
  })

  it("retries after a provider timeout without treating uncertainty as success", async () => {
    const f = fixture()
    f.update.mockImplementationOnce(() => {
      f.snapshot.pending_update = pending(5)
      return Promise.reject(new Error("timeout after provider accepted update"))
    })
    await expect(f.scheduler.schedule(actor)).rejects.toThrow("timeout")
    expect(await f.scheduler.schedule(actor)).toMatchObject({
      status: "unchanged",
    })
    expect(f.update).toHaveBeenCalledTimes(1)
  })

  it.each([
    { seats: 5 },
    { amount: 5000 },
    { pending_update: pending(8) },
    {
      current_period_end: "2026-11-11T12:00:00.000Z",
      pending_update: { ...pending(5), applies_at: "2026-11-11T12:00:00.000Z" },
    },
  ] satisfies Array<Partial<Snapshot>>)(
    "does not confirm an unexpected provider response: %j",
    async (patch) => {
      const f = fixture()
      f.update.mockResolvedValueOnce({
        ...f.snapshot,
        pending_update: pending(5),
        ...patch,
      })
      await expect(f.scheduler.schedule(actor)).rejects.toThrow(
        "reconciliation"
      )
    }
  )
})
