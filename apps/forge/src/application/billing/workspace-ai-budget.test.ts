import { describe, expect, it } from "vitest"
import {
  DEFAULT_WORKSPACE_OVERAGE_POLICY,
  evaluateWorkspaceBudgetAdmission,
  workspaceAiAllowanceMicros,
  workspaceOveragePolicySchema,
} from "./workspace-ai-budget"
import type { WorkspaceBudgetAdmissionInput } from "./workspace-ai-budget"

const base: WorkspaceBudgetAdmissionInput = {
  plan: "starter",
  accessPhase: "standard",
  feature: "agent",
  billingMode: "forge-managed",
  activeMembers: 3,
  settledCostMicros: 10_000_000,
  reservedCostMicros: 1_000_000,
  requestedReservationMicros: 2_000_000,
  overage: { enabled: false },
  paidOverageAuthorized: false,
}
describe("workspace AI allowance and capped overage", () => {
  it.each(["starter", "plus"] as const)(
    "keeps %s trial at USD 5 with no overage regardless of member count",
    (plan) => {
      for (const activeMembers of [1, 5, 20]) {
        expect(workspaceAiAllowanceMicros(plan, activeMembers, "trial")).toBe(
          5_000_000
        )
        for (const feature of ["agent", "calls", "signals"] as const) {
          expect(
            evaluateWorkspaceBudgetAdmission({
              ...base,
              plan,
              activeMembers,
              feature,
              accessPhase: "trial",
              settledCostMicros: 5_000_000,
              reservedCostMicros: 0,
              requestedReservationMicros: 1,
              overage: { enabled: true, monthlyCapMicros: 50_000_000 },
              paidOverageAuthorized: true,
            })
          ).toMatchObject({
            allowed: false,
            usesWorkspaceAiPool: true,
            includedMicros: 5_000_000,
            usableOverageMicros: 0,
          })
        }
      }
    }
  )
  it.each(["calls", "signals"] as const)(
    "keeps paid %s outside an exhausted pool and reserves zero allowance",
    (feature) => {
      for (const plan of ["starter", "plus"] as const) {
        expect(
          evaluateWorkspaceBudgetAdmission({
            ...base,
            plan,
            feature,
            settledCostMicros: 20_000_000,
          })
        ).toMatchObject({
          allowed: true,
          usesWorkspaceAiPool: false,
          allowanceReservationMicros: 0,
          projectedMicros: 21_000_000,
          requestedOverageMicros: 0,
        })
      }
      expect(
        evaluateWorkspaceBudgetAdmission({
          ...base,
          plan: "free",
          feature,
          settledCostMicros: 5_000_000,
        })
      ).toMatchObject({ allowed: false, usesWorkspaceAiPool: true })
    }
  )
  it("does not reserve allowance for directly provider-paid agent work after exhaustion", () => {
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...base,
        plan: "free",
        billingMode: "pay-as-you-go",
        settledCostMicros: 5_000_000,
      })
    ).toMatchObject({
      allowed: true,
      usesWorkspaceAiPool: false,
      allowanceReservationMicros: 0,
      requestedOverageMicros: 0,
    })
  })
  it.each(["starter", "plus"] as const)(
    "provides USD 5 per active member on %s",
    (plan) => {
      expect(workspaceAiAllowanceMicros(plan, 1, "standard")).toBe(5_000_000)
      expect(workspaceAiAllowanceMicros(plan, 3, "standard")).toBe(15_000_000)
      expect(workspaceAiAllowanceMicros(plan, 4, "standard")).toBe(20_000_000)
      expect(DEFAULT_WORKSPACE_OVERAGE_POLICY).toEqual({ enabled: false })
    }
  )
  it("keeps the Free workspace pool fixed at USD 5 as membership grows", () => {
    for (const members of [1, 2, 3, 4, 5, 6]) {
      // Existing oversized workspaces cannot mint credits by being over capacity.
      expect(workspaceAiAllowanceMicros("free", members, "standard")).toBe(
        5_000_000
      )
    }
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...base,
        plan: "free",
        activeMembers: 5,
        settledCostMicros: 3_000_000,
        reservedCostMicros: 1_000_000,
        requestedReservationMicros: 1_000_000,
      })
    ).toMatchObject({
      allowed: true,
      includedMicros: 5_000_000,
      projectedMicros: 5_000_000,
    })
  })
  it("denies Free overage even if stale paid opt-in and payment authorization remain", () => {
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...base,
        plan: "free",
        activeMembers: 5,
        settledCostMicros: 5_000_000,
        reservedCostMicros: 0,
        requestedReservationMicros: 1,
        overage: { enabled: true, monthlyCapMicros: 20_000_000 },
        paidOverageAuthorized: true,
      })
    ).toMatchObject({
      allowed: false,
      usableOverageMicros: 0,
      totalLimitMicros: 5_000_000,
    })
  })
  it("requires explicit standard plan classification, never a legacy alias or custom Enterprise default", () => {
    for (const plan of [
      undefined,
      "basic",
      "business",
      "enterprise",
      "unknown",
    ]) {
      expect(() =>
        evaluateWorkspaceBudgetAdmission({
          ...base,
          plan,
        } as unknown as WorkspaceBudgetAdmissionInput)
      ).toThrow()
    }
  })
  it("includes outstanding reservations rather than only settled cost", () => {
    expect(evaluateWorkspaceBudgetAdmission(base)).toMatchObject({
      allowed: true,
      includedMicros: 15_000_000,
      projectedMicros: 13_000_000,
      remainingMicros: 4_000_000,
      requestedOverageMicros: 0,
    })
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...base,
        reservedCostMicros: 4_000_000,
      }).allowed
    ).toBe(false)
  })
  it("allows a reservation up to the exact cap, then denies further runs", () => {
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...base,
        requestedReservationMicros: 4_000_000,
      }).allowed
    ).toBe(true)
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...base,
        settledCostMicros: 15_000_000,
        reservedCostMicros: 0,
        requestedReservationMicros: 0,
      }).allowed
    ).toBe(false)
  })
  it("requires both explicit capped opt-in and confirmed paid-overage authority", () => {
    const optedIn = {
      ...base,
      requestedReservationMicros: 6_000_000,
      overage: { enabled: true as const, monthlyCapMicros: 5_000_000 },
    }
    expect(evaluateWorkspaceBudgetAdmission(optedIn).allowed).toBe(false)
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...optedIn,
        paidOverageAuthorized: true,
      })
    ).toMatchObject({
      allowed: true,
      totalLimitMicros: 20_000_000,
      projectedMicros: 17_000_000,
      requestedOverageMicros: 2_000_000,
    })
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...optedIn,
        paidOverageAuthorized: true,
        requestedReservationMicros: 10_000_000,
      }).allowed
    ).toBe(false)
  })
  it("does not reset settled consumption when membership changes", () => {
    expect(
      evaluateWorkspaceBudgetAdmission({ ...base, activeMembers: 2 }).allowed
    ).toBe(false)
    expect(
      evaluateWorkspaceBudgetAdmission({ ...base, activeMembers: 4 })
        .remainingMicros
    ).toBe(9_000_000)
  })
  it("rejects unbounded caps and invalid accounting instead of assuming free usage", () => {
    expect(
      workspaceOveragePolicySchema.safeParse({ enabled: true }).success
    ).toBe(false)
    expect(
      workspaceOveragePolicySchema.safeParse({
        enabled: true,
        monthlyCapMicros: Infinity,
      }).success
    ).toBe(false)
    expect(
      workspaceOveragePolicySchema.safeParse({
        enabled: false,
        monthlyCapMicros: 5,
      }).success
    ).toBe(false)
    for (const value of [-1, 1.5, NaN, Infinity]) {
      expect(() =>
        evaluateWorkspaceBudgetAdmission({ ...base, settledCostMicros: value })
      ).toThrow()
    }
    expect(() =>
      evaluateWorkspaceBudgetAdmission({
        ...base,
        requestedReservationMicros: Number.MAX_SAFE_INTEGER,
      })
    ).toThrow()
  })
})
