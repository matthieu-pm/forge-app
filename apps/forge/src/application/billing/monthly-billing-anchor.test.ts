import { describe, expect, it } from "vitest"
import {
  captureMonthlyBillingAnchor,
  nextAnchoredMonth,
  replacementAnniversarySchedule,
} from "./monthly-billing-anchor"

describe("original monthly billing anniversary", () => {
  it.each([
    ["2027-01-31", "2027-02-28", "2027-03-31", 31],
    ["2028-01-31", "2028-02-29", "2028-03-31", 31],
    ["2027-02-28", "2027-03-31", "2027-04-30", 31],
    ["2027-01-30", "2027-02-28", "2027-03-30", 30],
    ["2027-11-30", "2027-12-30", "2028-01-30", 30],
    ["2027-12-15", "2028-01-15", "2028-02-15", 15],
  ])("retains the calendar day across %s → %s", (start, end, next, day) => {
    const result = captureMonthlyBillingAnchor(
      new Date(`${start}T17:42:03.123Z`),
      new Date(`${end}T17:42:03.123Z`)
    )
    expect(result.anchorDay).toBe(day)
    expect(result.nextRenewalAt.toISOString()).toBe(`${next}T17:42:03.123Z`)
  })
  it.each([
    ["2027-01-01", "2027-03-01"],
    ["2027-02-28", "2027-02-28"],
    ["2027-03-01", "2027-02-01"],
    ["2027-01-31", "2027-02-27"],
    ["2027-01-01T01:00:00Z", "2027-02-01T02:00:00Z"],
  ])("refuses ambiguous or nonmonthly periods %s → %s", (start, end) => {
    expect(() =>
      captureMonthlyBillingAnchor(new Date(start), new Date(end))
    ).toThrow("RECONCILIATION_REQUIRED")
  })
  it.each([0, 32, 1.5, NaN])("refuses invalid anchor %s", (day) => {
    expect(() => nextAnchoredMonth(new Date(), day)).toThrow("INVALID")
  })
  it("refuses invalid dates", () => {
    expect(() =>
      captureMonthlyBillingAnchor(new Date(NaN), new Date())
    ).toThrow("INVALID")
  })
  function schedule() {
    return {
      originalPeriodStart: new Date("2026-12-31T17:42:03.123Z"),
      effectiveAt: new Date("2027-01-31T17:42:03.123Z"),
      anchorDay: 31,
      nextRenewalAt: new Date("2027-02-28T17:42:03.123Z"),
      checkoutGraceEndsAt: new Date("2027-02-07T17:42:03.123Z"),
      paidAt: new Date("2027-02-05T20:00:00Z"),
    }
  }
  it("late payment preserves the old usage anniversary and retains a short-month repair", () => {
    expect(replacementAnniversarySchedule(schedule())).toEqual({
      usagePeriodStart: "2027-01-31T17:42:03.123Z",
      usagePeriodEnd: "2027-02-28T17:42:03.123Z",
      paidAt: "2027-02-05T20:00:00.000Z",
      originalAnchorDay: 31,
      alignedPeriodEnd: "2027-02-28T17:42:03.123Z",
      followingPeriodEnd: "2027-03-31T17:42:03.123Z",
      followUpRequired: true,
      grantsFreshPaidPool: false,
    })
  })
  it("accepts payment at the original boundary with no unnecessary following-month repair", () => {
    const value = schedule()
    const original = captureMonthlyBillingAnchor(
      new Date("2027-01-15T17:42:03.123Z"),
      new Date("2027-02-15T17:42:03.123Z")
    )
    expect(
      replacementAnniversarySchedule({
        ...value,
        ...original,
        checkoutGraceEndsAt: new Date("2027-02-22T17:42:03.123Z"),
        paidAt: original.effectiveAt,
      }).followUpRequired
    ).toBe(false)
  })
  it.each(["2027-01-31T17:42:03.122Z", "2027-02-07T17:42:03.123Z"])(
    "refuses payment outside the original half-open grace window: %s",
    (paid) => {
      expect(() =>
        replacementAnniversarySchedule({
          ...schedule(),
          paidAt: new Date(paid),
        })
      ).toThrow("OUTSIDE_CHECKOUT_GRACE")
    }
  )
  it.each([
    { anchorDay: 28 },
    { nextRenewalAt: new Date("2027-03-05T20:00:00Z") },
    { checkoutGraceEndsAt: new Date("2027-02-08T17:42:03.123Z") },
  ])("refuses a moved anniversary or restarted grace", (patch) => {
    expect(() =>
      replacementAnniversarySchedule({ ...schedule(), ...patch })
    ).toThrow("RECONCILIATION_REQUIRED")
  })
})
