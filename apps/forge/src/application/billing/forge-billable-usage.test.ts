import { describe, expect, it } from "vitest"
import { forgeBillableCostMicros } from "./forge-billable-usage"

const base = {
  plan: "free",
  accessPhase: "standard",
  feature: "agent",
  billingMode: "forge-managed",
  providerCostMicros: 1_234_567,
}
describe("Forge allowance usage classification", () => {
  it.each(["starter", "plus"])(
    "meters every managed feature during a %s trial",
    (plan) => {
      for (const feature of ["agent", "calls", "signals"]) {
        expect(
          forgeBillableCostMicros({
            ...base,
            plan,
            feature,
            accessPhase: "trial",
          })
        ).toBe(1_234_567)
        expect(
          forgeBillableCostMicros({
            ...base,
            plan,
            feature,
            accessPhase: "trial",
            billingMode: "pay-as-you-go",
          })
        ).toBe(0)
      }
    }
  )
  it.each(["free", "starter", "plus"])(
    "meters agent usage at provider cost on %s",
    (plan) => {
      expect(forgeBillableCostMicros({ ...base, plan })).toBe(1_234_567)
      expect(
        forgeBillableCostMicros({ ...base, plan, providerCostMicros: 0 })
      ).toBe(0)
    }
  )
  it.each(["calls", "signals"])(
    "meters Free %s in the shared fixed workspace allowance",
    (feature) => {
      expect(forgeBillableCostMicros({ ...base, feature })).toBe(1_234_567)
    }
  )
  it.each(["starter", "plus"])(
    "excludes Calls and Signals from %s allowance and overage",
    (plan) => {
      for (const feature of ["calls", "signals"]) {
        expect(forgeBillableCostMicros({ ...base, plan, feature })).toBe(0)
        // Allowance exclusion does not fabricate a provider-cost measurement.
        expect(
          forgeBillableCostMicros({
            ...base,
            plan,
            feature,
            providerCostMicros: null,
          })
        ).toBe(0)
      }
    }
  )
  it.each(["pay-as-you-go", "subscription", "token-plan"])(
    "excludes directly paid usage (%s) on every plan and feature",
    (billingMode) => {
      for (const plan of ["free", "starter", "plus"]) {
        for (const feature of ["agent", "calls", "signals"]) {
          expect(
            forgeBillableCostMicros({
              ...base,
              plan,
              feature,
              billingMode,
              providerCostMicros: null,
            })
          ).toBe(0)
        }
      }
    }
  )
  it("requires trusted plan, feature and payer classifications before applying exclusions", () => {
    for (const patch of [
      { plan: undefined },
      { plan: "business" },
      { plan: "enterprise" },
      { accessPhase: undefined },
      { accessPhase: "unknown" },
      { plan: "free", accessPhase: "trial" },
      { feature: undefined },
      { feature: "unknown" },
      { billingMode: undefined },
      { billingMode: "unknown" },
    ])
      expect(() => forgeBillableCostMicros({ ...base, ...patch })).toThrow()
    for (const providerCostMicros of [null, -1, 1.5, NaN, Infinity]) {
      expect(() =>
        forgeBillableCostMicros({ ...base, providerCostMicros })
      ).toThrow()
    }
  })
})
