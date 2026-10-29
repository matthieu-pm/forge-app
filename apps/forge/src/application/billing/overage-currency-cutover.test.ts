import { describe, expect, it } from "vitest"
import { planOverageCurrencyCutover } from "./overage-currency-cutover"
import {
  ECB_REFERENCE_URL,
  convertBillingCapacity,
} from "./workspace-overage-money"
import type { EcbRateSnapshot } from "./workspace-overage-money"

const at = new Date("2026-10-29T10:00:00Z")
const rate: EcbRateSnapshot = {
  id: "a".repeat(64),
  source: "ecb-daily-reference",
  sourceUrl: ECB_REFERENCE_URL,
  referenceDate: "2026-10-28",
  observedAt: "2026-10-29T09:59:00Z",
  usdPerEur: "1.2500",
}
function input() {
  return {
    fromCurrency: "usd" as const,
    targetCurrency: "eur" as const,
    policy: {
      enabled: true as const,
      currency: "usd" as const,
      monthlyCapMicros: 10_000_000,
    },
    settledMicros: 3_000_000,
    reservedMicros: 2_000_000,
    periodStart: new Date("2026-10-25T00:00:00Z"),
    periodEnd: new Date("2026-11-25T00:00:00Z"),
    cutoverAt: at,
    rate,
  }
}
describe("currency-change cap and committed capacity", () => {
  it("converts the opted-in cap and carries consumption rather than granting fresh capacity", () => {
    const value = input(),
      before = structuredClone(value),
      result = planOverageCurrencyCutover(value)
    expect(result).toMatchObject({
      policy: { enabled: true, currency: "eur", monthlyCapMicros: 8_000_000 },
      settledCapacity: { amountMicros: 2_400_000, rate },
      reservedCapacity: { amountMicros: 1_600_000, rate },
      committedCapacityMicros: 4_000_000,
      remainingCapacityMicros: 4_000_000,
      grantsPaymentAuthority: false,
      rewritesHistoricalCharges: false,
    })
    expect(value).toEqual(before)
    expect(planOverageCurrencyCutover(value)).toEqual(result)
  })
  it("multiplies EUR by USD-per-EUR in the reverse direction", () => {
    expect(
      planOverageCurrencyCutover({
        ...input(),
        fromCurrency: "eur",
        targetCurrency: "usd",
        policy: { enabled: true, currency: "eur", monthlyCapMicros: 8_000_000 },
        settledMicros: 2_000_000,
        reservedMicros: 2_000_000,
      })
    ).toMatchObject({
      policy: { enabled: true, currency: "usd", monthlyCapMicros: 10_000_000 },
      committedCapacityMicros: 5_000_000,
      remainingCapacityMicros: 5_000_000,
    })
  })
  it("does not enlarge the converted cap and rounds capacity reservations up, retaining exact fractions", () => {
    const result = planOverageCurrencyCutover({
      ...input(),
      policy: { enabled: true, currency: "usd", monthlyCapMicros: 10 },
      settledMicros: 1,
      reservedMicros: 1,
      rate: { ...rate, usdPerEur: "3" },
    })
    expect(result).toMatchObject({
      policy: { monthlyCapMicros: 3 },
      settledCapacity: {
        amountMicros: 1,
        exactNumerator: "1",
        exactDenominator: "3",
      },
      reservedCapacity: { amountMicros: 1 },
      remainingCapacityMicros: 1,
    })
  })
  it("keeps disabled overage disabled and preserves its historical committed capacity", () => {
    const result = planOverageCurrencyCutover({
      ...input(),
      policy: { enabled: false },
    })
    expect(result).toMatchObject({
      policy: { enabled: false },
      cap: null,
      committedCapacityMicros: 4_000_000,
      remainingCapacityMicros: 0,
      grantsPaymentAuthority: false,
    })
  })
  it("requires no rate for an unchanged currency", () => {
    const result = planOverageCurrencyCutover({
      ...input(),
      targetCurrency: "usd",
      rate: undefined,
    })
    expect(result).toMatchObject({
      policy: { monthlyCapMicros: 10_000_000 },
      committedCapacityMicros: 5_000_000,
      remainingCapacityMicros: 5_000_000,
      cap: { rate: null },
    })
  })
  it("keeps zero-cap or disabled empty policies unusable without demanding an unnecessary quote", () => {
    for (const policy of [
      { enabled: false } as const,
      { enabled: true, currency: "usd", monthlyCapMicros: 0 } as const,
    ])
      expect(
        planOverageCurrencyCutover({
          ...input(),
          policy,
          settledMicros: 0,
          reservedMicros: 0,
          rate: undefined,
        }).remainingCapacityMicros
      ).toBe(0)
  })
  it("keeps already-exhausted/overspent caps exhausted", () => {
    expect(
      planOverageCurrencyCutover({
        ...input(),
        settledMicros: 11_000_000,
        reservedMicros: 0,
      }).remainingCapacityMicros
    ).toBe(0)
  })
  it.each([
    undefined,
    { ...rate, usdPerEur: "0" },
    { ...rate, usdPerEur: "1e2" },
    { ...rate, referenceDate: "2026-10-01" },
    { ...rate, referenceDate: "2026-10-30" },
    { ...rate, observedAt: "2026-10-29T11:00:00Z" },
  ])("refuses unavailable or invalid conversion evidence: %j", (quote) => {
    expect(() =>
      planOverageCurrencyCutover({ ...input(), rate: quote })
    ).toThrow()
  })
  it("rejects mismatched source currency before carrying an opt-in", () => {
    expect(() =>
      planOverageCurrencyCutover({
        ...input(),
        policy: { enabled: true, currency: "eur", monthlyCapMicros: 1 },
      })
    ).toThrow("CURRENCY_MISMATCH")
  })
  it.each([
    new Date("2026-10-24T23:59:59Z"),
    new Date("2026-11-25T00:00:00Z"),
    new Date(NaN),
  ])(
    "rejects a cutover outside the retained commercial period: %s",
    (cutoverAt) => {
      expect(() =>
        planOverageCurrencyCutover({ ...input(), cutoverAt })
      ).toThrow()
    }
  )
  it("rejects amount/aggregate overflow using bigint intermediates", () => {
    expect(() =>
      planOverageCurrencyCutover({
        ...input(),
        reservedMicros: Number.MAX_SAFE_INTEGER,
        rate: { ...rate, usdPerEur: "0.00000001" },
      })
    ).toThrow("OVERFLOW")
    expect(() =>
      planOverageCurrencyCutover({
        ...input(),
        targetCurrency: "usd",
        settledMicros: Number.MAX_SAFE_INTEGER,
        reservedMicros: 1,
      })
    ).toThrow("OVERFLOW")
    expect(
      convertBillingCapacity({
        fromCurrency: "eur",
        targetCurrency: "usd",
        amountMicros: Number.MAX_SAFE_INTEGER,
        at,
        rate: { ...rate, usdPerEur: "1.00000000" },
        rounding: "up",
      }).amountMicros
    ).toBe(Number.MAX_SAFE_INTEGER)
  })
})
