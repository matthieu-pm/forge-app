import { describe, expect, it } from "vitest"
import {
  ECB_REFERENCE_URL,
  convertOverageCost,
  reserveWorkspaceOverage,
} from "./workspace-overage-money"
import { evaluateWorkspaceBudgetAdmission } from "./workspace-ai-budget"
import type { EcbRateSnapshot } from "./workspace-overage-money"

const at = new Date("2026-10-29T00:00:00Z")
const rate: EcbRateSnapshot = {
  id: "a".repeat(64),
  source: "ecb-daily-reference",
  sourceUrl: ECB_REFERENCE_URL,
  referenceDate: "2026-10-28",
  observedAt: "2026-10-28T16:30:00Z",
  usdPerEur: "1.2500",
}
describe("usage-time overage currency", () => {
  it("divides the ECB USD-per-EUR quote, preserving USD provider cost and original snapshot", () => {
    expect(
      convertOverageCost({
        currency: "eur",
        providerUsdMicros: 5_000_000,
        incurredAt: at,
        rate,
        rounding: "settlement",
      })
    ).toMatchObject({
      currency: "eur",
      providerUsdMicros: 5_000_000,
      amountMicros: 4_000_000,
      rate,
      incurredAt: at.toISOString(),
    })
    expect(
      convertOverageCost({
        currency: "usd",
        providerUsdMicros: 5_000_000,
        incurredAt: at,
        rounding: "settlement",
      }).amountMicros
    ).toBe(5_000_000)
  })
  it("reserves upwards, settles half-up and retains the exact fraction for invoice aggregation", () => {
    const quote = { ...rate, usdPerEur: "3" },
      input = {
        currency: "eur" as const,
        providerUsdMicros: 1,
        incurredAt: at,
        rate: quote,
      }
    expect(
      convertOverageCost({ ...input, rounding: "reservation" })
    ).toMatchObject({
      amountMicros: 1,
      exactNumerator: "1",
      exactDenominator: "3",
    })
    expect(
      convertOverageCost({ ...input, rounding: "settlement" }).amountMicros
    ).toBe(0)
    expect(
      convertOverageCost({
        ...input,
        rate: { ...quote, usdPerEur: "2" },
        rounding: "settlement",
      }).amountMicros
    ).toBe(1)
  })
  it("keeps the original usage-time quote when billing later, refusing a quote observed afterwards", () => {
    const input = {
      currency: "eur" as const,
      providerUsdMicros: 5_000_000,
      incurredAt: at,
      rate,
      rounding: "settlement" as const,
    }
    const first = convertOverageCost(input)
    expect(convertOverageCost(input)).toEqual(first)
    expect(() =>
      convertOverageCost({
        ...input,
        rate: { ...rate, observedAt: "2026-10-29T01:00:00Z", usdPerEur: "2" },
      })
    ).toThrow("UNAVAILABLE_FOR_USAGE")
  })
  it.each([
    undefined,
    { ...rate, usdPerEur: "0" },
    { ...rate, usdPerEur: "1e3" },
    { ...rate, referenceDate: "2026-10-01" },
    { ...rate, referenceDate: "2026-10-30" },
  ])("refuses missing, stale or malformed EUR conversion: %j", (quote) => {
    expect(() =>
      convertOverageCost({
        currency: "eur",
        providerUsdMicros: 1,
        incurredAt: at,
        rate: quote,
        rounding: "reservation",
      })
    ).toThrow()
  })
  it("uses bigint intermediate arithmetic and rejects unsupported result magnitude", () => {
    expect(
      convertOverageCost({
        currency: "eur",
        providerUsdMicros: Number.MAX_SAFE_INTEGER,
        incurredAt: at,
        rate: { ...rate, usdPerEur: "1.00000000" },
        rounding: "reservation",
      }).amountMicros
    ).toBe(Number.MAX_SAFE_INTEGER)
    expect(() =>
      convertOverageCost({
        currency: "eur",
        providerUsdMicros: Number.MAX_SAFE_INTEGER,
        incurredAt: at,
        rate: { ...rate, usdPerEur: "0.00000001" },
        rounding: "reservation",
      })
    ).toThrow("OVERFLOW")
  })
  it("enforces the EUR cap against EUR settled and reserved amounts at the exact boundary", () => {
    const input = {
      currency: "eur" as const,
      capMicros: 5_000_000,
      settledMicros: 3_000_000,
      reservedMicros: 400_000,
      requestedUsdMicros: 2_000_000,
      incurredAt: at,
      rate,
    }
    expect(reserveWorkspaceOverage(input)).toMatchObject({
      allowed: true,
      projectedMicros: 5_000_000,
      reservation: { amountMicros: 1_600_000, currency: "eur" },
    })
    expect(
      reserveWorkspaceOverage({ ...input, requestedUsdMicros: 2_000_001 })
        .allowed
    ).toBe(false)
  })
  const input = {
    plan: "starter" as const,
    accessPhase: "standard" as const,
    feature: "agent" as const,
    billingMode: "forge-managed" as const,
    activeMembers: 1,
    billingCurrency: "eur" as const,
    settledCostMicros: 4_000_000,
    reservedCostMicros: 0,
    requestedReservationMicros: 3_000_000,
    settledOverageMicros: 1_000_000,
    reservedOverageMicros: 0,
    incurredAt: at,
    rate,
    overage: {
      enabled: true as const,
      currency: "eur" as const,
      monthlyCapMicros: 2_600_000,
    },
    paidOverageAuthorized: true,
  }
  it("crosses the unchanged USD pool into an EUR reservation without adding different currencies", () => {
    expect(evaluateWorkspaceBudgetAdmission(input)).toMatchObject({
      allowed: true,
      includedMicros: 5_000_000,
      requestedOverageMicros: 2_000_000,
      usableOverageMicros: null,
      totalLimitMicros: null,
      billingOverageReservation: { currency: "eur", amountMicros: 1_600_000 },
      costCurrency: "usd",
    })
    expect(
      evaluateWorkspaceBudgetAdmission({ ...input, reservedOverageMicros: 1 })
        .allowed
    ).toBe(false)
  })
  it("allows remaining included usage without FX and never charges paid Calls/Signals or BYOK", () => {
    expect(
      evaluateWorkspaceBudgetAdmission({
        ...input,
        rate: undefined,
        requestedReservationMicros: 1_000_000,
      }).allowed
    ).toBe(true)
    for (const patch of [
      { feature: "calls" as const },
      { feature: "signals" as const },
      { billingMode: "pay-as-you-go" as const },
    ])
      expect(
        evaluateWorkspaceBudgetAdmission({
          ...input,
          rate: undefined,
          ...patch,
        })
      ).toMatchObject({
        allowed: true,
        requestedOverageMicros: 0,
        billingOverageReservation: null,
      })
  })
  it("refuses currency-mismatched or unlabeled enabled caps without a 1:1 fallback", () => {
    expect(() =>
      evaluateWorkspaceBudgetAdmission({
        ...input,
        overage: { ...input.overage, currency: "usd" },
      })
    ).toThrow("CURRENCY_MISMATCH")
    expect(() =>
      evaluateWorkspaceBudgetAdmission({ ...input, rate: undefined })
    ).toThrow()
  })
})
