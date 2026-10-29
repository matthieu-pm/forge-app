import { describe, expect, it } from "vitest"
import { trialExpiryCarryover } from "./trial-usage-carryover"
import { subscriptionAccess } from "./subscription-access"

const input = {
  workspaceId: "workspace",
  redemptionId: "00000000-0000-4000-8000-000000000001",
  workspaceCreatedAt: new Date("2026-01-31T10:00:00Z"),
  trialStartedAt: new Date("2026-02-20T10:00:00Z"),
  now: new Date("2026-03-06T10:00:00Z"),
  settledTrialMicros: 4_000_000,
  reservedTrialMicros: 1_000_000,
}
describe("trial expiry capacity carryover", () => {
  it("carries committed trial capacity to the original Free anniversary without a new grant/charge", () => {
    const result = trialExpiryCarryover(input)
    expect(result.targetPeriod.start.toISOString()).toBe(
      "2026-02-28T10:00:00.000Z"
    )
    expect(result.committedCapacityMicros).toBe(5_000_000)
    expect(result.newAllowanceMicros).toBe(0)
    expect(result.billableMicros).toBe(0)
    expect(result.appliesToCurrentFreePeriod).toBe(true)
  })
  it("keeps the same destination on late delivery and stops affecting the next legitimate Free pool", () => {
    const first = trialExpiryCarryover(input),
      late = trialExpiryCarryover({
        ...input,
        now: new Date("2026-04-02T10:00:00Z"),
      })
    expect(late.key).toBe(first.key)
    expect(late.appliesToCurrentFreePeriod).toBe(false)
    expect(late.targetPeriod.end.toISOString()).toBe("2026-03-31T10:00:00.000Z")
  })
  it("settling reservations changes capacity components, not identity or total commitment", () => {
    const first = trialExpiryCarryover(input),
      settled = trialExpiryCarryover({
        ...input,
        settledTrialMicros: 5_000_000,
        reservedTrialMicros: 0,
      })
    expect(settled.key).toBe(first.key)
    expect(settled.committedCapacityMicros).toBe(first.committedCapacityMicros)
  })
  it.each([
    { settledTrialMicros: -1 },
    { reservedTrialMicros: 0.1 },
    { settledTrialMicros: Number.MAX_SAFE_INTEGER },
    { now: new Date("2026-03-06T09:59:59Z") },
    { now: new Date(NaN) },
    { trialStartedAt: new Date("2026-01-01") },
  ])("rejects invalid or premature state %o", (patch) => {
    expect(() => trialExpiryCarryover({ ...input, ...patch })).toThrow()
  })
})
describe("trial entitlement boundaries", () => {
  const state = {
    plan: "business",
    status: "trialing",
    source: "forge-trial",
    sourceReference: input.redemptionId,
    trialRedemptionId: input.redemptionId,
    currentPeriodStart: input.trialStartedAt,
    currentPeriodEnd: input.now,
  }
  it("requires the bound original half-open 14-day window", () => {
    expect(subscriptionAccess(state, input.trialStartedAt).phase).toBe("trial")
    expect(
      subscriptionAccess(state, new Date(input.now.getTime() - 1)).phase
    ).toBe("trial")
    expect(subscriptionAccess(state, input.now).phase).toBe("free")
    expect(
      subscriptionAccess(state, new Date(input.trialStartedAt.getTime() - 1))
        .phase
    ).toBe("free")
  })
  it.each([
    { trialRedemptionId: null },
    { sourceReference: "other" },
    { providerEnvironment: "sandbox" },
    { paidActivatedAt: input.trialStartedAt },
    { cancelAtPeriodEnd: true },
    { currentPeriodEnd: new Date(input.now.getTime() + 1) },
    { status: "active" },
  ])("denies inconsistent trial projection %o", (patch) => {
    expect(
      subscriptionAccess({ ...state, ...patch }, input.trialStartedAt).phase
    ).toBe("free")
  })
})
