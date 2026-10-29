import { describe, expect, it } from "vitest"
import { planMonthlyOverageReport } from "./overage-invoice-contract"
import {
  ECB_REFERENCE_URL,
  convertOverageCost,
} from "./workspace-overage-money"
import type { EcbRateSnapshot } from "./workspace-overage-money"

const at = new Date("2026-10-29T00:00:00Z"),
  id = "00000000-0000-4000-8000-000000000001"
const money = (amount: number) =>
  convertOverageCost({
    currency: "usd",
    providerUsdMicros: amount,
    incurredAt: at,
    rounding: "settlement",
  })
const rate: EcbRateSnapshot = {
  id: "a".repeat(64),
  source: "ecb-daily-reference" as const,
  sourceUrl: ECB_REFERENCE_URL,
  referenceDate: "2026-10-28",
  observedAt: "2026-10-28T16:30:00Z",
  usdPerEur: "3",
}
describe("monthly overage invoice aggregation", () => {
  it("aggregates before rounding rather than rounding every run", () => {
    const usage = Array.from({ length: 5 }, (_, i) => ({
      usageId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      money: money(1001),
    }))
    expect(
      planMonthlyOverageReport({
        currency: "usd",
        previouslyReportedMinor: 0,
        usage,
      })
    ).toMatchObject({ totalMinor: 1, reportableMinor: 1, usageCount: 5 })
  })
  it("retains exact EUR fractions rather than rounding micro amounts before invoice totals", () => {
    const converted = convertOverageCost({
      currency: "eur",
      providerUsdMicros: 14999,
      incurredAt: at,
      rate,
      rounding: "settlement",
    })
    expect(converted.amountMicros).toBe(5000)
    expect(
      planMonthlyOverageReport({
        currency: "eur",
        previouslyReportedMinor: 0,
        usage: [{ usageId: id, money: converted }],
      }).totalMinor
    ).toBe(0)
  })
  it("freezes usage-time EUR rates instead of using the invoice date's exchange rate", () => {
    const converted = convertOverageCost({
      currency: "eur",
      providerUsdMicros: 3_000_000,
      incurredAt: at,
      rate,
      rounding: "settlement",
    })
    expect(
      planMonthlyOverageReport({
        currency: "eur",
        previouslyReportedMinor: 0,
        usage: [{ usageId: id, money: converted }],
      })
    ).toMatchObject({ totalMinor: 100, reportableMinor: 100 })
  })
  it("reports only the incremental minor units when old-period usage settles late", () => {
    const r = planMonthlyOverageReport({
      currency: "usd",
      previouslyReportedMinor: 10,
      usage: [{ usageId: id, money: money(105000) }],
    })
    expect(r).toMatchObject({ totalMinor: 11, reportableMinor: 1 })
    expect(
      planMonthlyOverageReport({
        currency: "usd",
        previouslyReportedMinor: 11,
        usage: [{ usageId: id, money: money(105000) }],
      }).reportableMinor
    ).toBe(0)
  })
  it("refuses duplicate usage IDs, even with matching bodies", () => {
    const row = { usageId: id, money: money(1000) }
    expect(() =>
      planMonthlyOverageReport({
        currency: "usd",
        previouslyReportedMinor: 0,
        usage: [row, row],
      })
    ).toThrow("BILLING_DUPLICATE_USAGE")
  })
  it("requires a credit workflow when a correction falls below prior delivery", () => {
    expect(() =>
      planMonthlyOverageReport({
        currency: "usd",
        previouslyReportedMinor: 2,
        usage: [{ usageId: id, money: money(10000) }],
      })
    ).toThrow("BILLING_CREDIT_RECONCILIATION_REQUIRED")
  })
  it.each([
    { currency: "eur" as const, money: money(1000) },
    {
      currency: "usd" as const,
      money: { ...money(1000), rounding: "reservation" as const },
    },
  ])("rejects mixed currency or unsettled amounts %o", (row) => {
    expect(() =>
      planMonthlyOverageReport({
        currency: row.currency,
        previouslyReportedMinor: 0,
        usage: [{ usageId: id, money: row.money }],
      })
    ).toThrow("BILLING_UNSETTLED_OR_MIXED_CURRENCY")
  })
  it.each([
    { amountMicros: 1 },
    { exactNumerator: "1" },
    { exactDenominator: "2" },
  ])("rejects tampered frozen conversion %o", (patch) => {
    expect(() =>
      planMonthlyOverageReport({
        currency: "usd",
        previouslyReportedMinor: 0,
        usage: [{ usageId: id, money: { ...money(1000), ...patch } }],
      })
    ).toThrow("BILLING_CONVERSION_CHANGED")
  })
  it("does not invent a charge for an empty period", () => {
    expect(
      planMonthlyOverageReport({
        currency: "usd",
        previouslyReportedMinor: 0,
        usage: [],
      })
    ).toMatchObject({ totalMinor: 0, reportableMinor: 0 })
  })
  it.each([-1, 0.5, NaN])(
    "rejects invalid prior invoice amount %s",
    (previous) => {
      expect(() =>
        planMonthlyOverageReport({
          currency: "usd",
          previouslyReportedMinor: previous,
          usage: [],
        })
      ).toThrow()
    }
  )
})
