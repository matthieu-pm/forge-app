import { describe, expect, it } from "vitest"
import { resolveWorkspaceUsageAuthority } from "./usage-authority"
import { paidToFreeCarryover } from "./paid-usage-carryover"
import { PAYMENT_GRACE_MS } from "./subscription-access"
import type { SubscriptionAccessState } from "./subscription-access"

const start = new Date("2026-10-01T12:00:00Z"),
  end = new Date("2026-11-01T12:00:00Z")
const base: SubscriptionAccessState = {
  source: "polar",
  providerEnvironment: "sandbox",
  sourceReference: "subscription",
  plan: "basic",
  status: "active",
  paidActivatedAt: start,
  currentPeriodStart: start,
  currentPeriodEnd: end,
}
const resolve = (state: SubscriptionAccessState | null, now = end) =>
  resolveWorkspaceUsageAuthority({
    workspaceId: "workspace",
    workspaceCreatedAt: new Date("2026-01-31T12:00:00Z"),
    state,
    now,
  })
describe("authoritative usage periods", () => {
  it("uses an active paid window, then derives downgrade from original end", () => {
    expect(resolve(base, new Date(end.getTime() - 1))).toMatchObject({
      kind: "paid",
      plan: "starter",
      grace: false,
      transition: null,
    })
    expect(resolve(base)).toMatchObject({
      kind: "free",
      plan: "free",
      transition: { kind: "paid-to-free", effectiveAt: end },
    })
  })
  it("does not reset the period when entering grace", () => {
    const state = {
      ...base,
      status: "past_due",
      paymentFailedAt: end,
      graceExpiresAt: new Date(end.getTime() + PAYMENT_GRACE_MS),
    }
    expect(resolve(state, end)).toMatchObject({
      kind: "paid",
      period: null,
      grace: true,
    })
    expect(resolve(state, state.graceExpiresAt)).toMatchObject({
      kind: "free",
      transition: { effectiveAt: state.graceExpiresAt },
    })
  })
  it("uses a scheduled cancellation cutoff even if another rule could grant grace", () => {
    expect(
      resolve({
        ...base,
        status: "canceled",
        cancelAtPeriodEnd: true,
        cancellationPeriodEnd: end,
      })
    ).toMatchObject({ kind: "free", transition: { effectiveAt: end } })
  })
  it.each(["terminatedAt", "unsupportedPauseAt"] as const)(
    "uses the effective %s instant rather than later delivery",
    (field) => {
      const at = new Date("2026-10-20T12:00:00Z")
      expect(
        resolve({ ...base, [field]: at }, new Date("2026-10-25T12:00:00Z"))
      ).toMatchObject({ kind: "free", transition: { effectiveAt: at } })
    }
  )
  it("uses the original full base-refund instant and does not mistake an upgrade refund for Free", () => {
    const at = new Date("2026-10-20T12:00:00Z")
    const refund = {
      orderId: "order",
      subscriptionId: "subscription",
      environment: "sandbox",
      start: start.toISOString(),
      end: end.toISOString(),
      refundedAt: at.toISOString(),
    }
    expect(resolve({ ...base, refundedPeriods: [refund] }, at)).toMatchObject({
      kind: "free",
      transition: { effectiveAt: at },
    })
    expect(
      resolve(
        {
          ...base,
          paidUpgradeOrderId: "order",
          refundedPeriods: [
            {
              ...refund,
              kind: "upgrade",
              starterOrderId: "base",
              basePeriodStart: start.toISOString(),
              basePeriodEnd: end.toISOString(),
            },
          ],
        },
        at
      )
    ).toMatchObject({ kind: "paid", plan: "starter", transition: null })
  })
  it("does not grant a paid account to an unpaid checkout", () => {
    expect(
      resolve({ ...base, status: "past_due", paidActivatedAt: null })
    ).toMatchObject({ kind: "free", transition: null })
  })
  it("requires provider authority for internal paid/manual/legacy trial projections", () => {
    expect(() => resolve({ ...base, source: "internal" }, start)).toThrow(
      "USAGE_PAID_BINDING_REQUIRED"
    )
    expect(() =>
      resolve({ ...base, source: "internal", status: "trialing" }, start)
    ).toThrow("USAGE_BOUND_TRIAL_REQUIRED")
  })
  it("refuses unknown Enterprise terms and malformed active paid periods", () => {
    expect(() => resolve({ ...base, plan: "enterprise" }, start)).toThrow(
      "USAGE_ENTERPRISE_AGREEMENT_REQUIRED"
    )
    expect(() =>
      resolve({ ...base, providerEnvironment: null }, start)
    ).toThrow("USAGE_PAID_BINDING_REQUIRED")
  })
  it("uses the immutable trial end on delayed expiry", () => {
    const trialEnd = new Date(start.getTime() + 14 * 86400000),
      state = {
        ...base,
        source: "forge-trial",
        sourceReference: "trial",
        trialRedemptionId: "trial",
        providerEnvironment: null,
        paidActivatedAt: null,
        status: "trialing",
        currentPeriodEnd: trialEnd,
      }
    expect(resolve(state, start)).toMatchObject({
      kind: "trial",
      phase: "trial",
      binding: "trial",
    })
    expect(resolve(state, end)).toMatchObject({
      kind: "free",
      transition: { kind: "trial-expiry", effectiveAt: trialEnd },
    })
  })
})

describe("paid-to-Free carryover", () => {
  const input = {
    workspaceId: "workspace",
    sourcePeriodId: "00000000-0000-4000-8000-000000000001",
    workspaceCreatedAt: new Date("2026-01-31T12:00:00Z"),
    paidAccessEndedAt: new Date("2026-02-20T12:00:00Z"),
    now: new Date("2026-02-21T12:00:00Z"),
    settledPoolUsdMicros: 4_500_000,
    reservedPoolUsdMicros: 1_000_000,
  }
  it("carries spent and in-flight exposure without another grant or invoice", () => {
    const r = paidToFreeCarryover(input)
    expect(r.committedCapacityMicros).toBe(5_500_000)
    expect(r.newAllowanceMicros).toBe(0)
    expect(r.billableMicros).toBe(0)
    expect(r.targetPeriod.end.toISOString()).toBe("2026-02-28T12:00:00.000Z")
  })
  it("keeps the original target when delivery is late and lets the next legitimate Free month reset", () => {
    const a = paidToFreeCarryover(input),
      b = paidToFreeCarryover({
        ...input,
        now: new Date("2026-03-05T12:00:00Z"),
      })
    expect(b.key).toBe(a.key)
    expect(a.appliesToCurrentFreePeriod).toBe(true)
    expect(b.appliesToCurrentFreePeriod).toBe(false)
  })
  it("uses one shadow as reserved costs settle, without double consumption", () => {
    const a = paidToFreeCarryover(input),
      b = paidToFreeCarryover({
        ...input,
        settledPoolUsdMicros: 5_500_000,
        reservedPoolUsdMicros: 0,
      })
    expect(b.key).toBe(a.key)
    expect(b.committedCapacityMicros).toBe(a.committedCapacityMicros)
  })
  it.each([
    { settledPoolUsdMicros: -1 },
    { reservedPoolUsdMicros: 0.5 },
    { settledPoolUsdMicros: Number.MAX_SAFE_INTEGER },
    { now: new Date("2026-02-19") },
    { paidAccessEndedAt: new Date(NaN) },
    { workspaceId: "" },
  ])("rejects invalid accounting %o", (patch) => {
    expect(() => paidToFreeCarryover({ ...input, ...patch })).toThrow()
  })
})
