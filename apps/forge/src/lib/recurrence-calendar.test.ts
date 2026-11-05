import { describe, expect, it } from "vitest"
import {
  nextRecurrenceIndex,
  recurrenceDate,
  recurrenceIndexOnDate,
  recurrenceInstant,
} from "./recurrence-calendar"

const schedule = {
  firstDue: "2026-01-31",
  unit: "month" as const,
  interval: 1,
  timezone: "Europe/Paris",
  generationTime: "02:30",
}
describe("recurrence calendar policy", () => {
  it("moves Paris spring gaps forward and chooses the earlier autumn fold", () => {
    expect(
      recurrenceInstant("2026-03-29", "02:30", "Europe/Paris").toISOString()
    ).toBe("2026-03-29T01:30:00.000Z")
    expect(
      recurrenceInstant("2026-10-25", "02:30", "Europe/Paris").toISOString()
    ).toBe("2026-10-25T00:30:00.000Z")
  })
  it("handles half-hour transitions and a skipped calendar date", () => {
    expect(
      recurrenceInstant(
        "2026-10-04",
        "02:15",
        "Australia/Lord_Howe"
      ).toISOString()
    ).toBe("2026-10-03T15:45:00.000Z")
    expect(
      recurrenceInstant("2011-12-30", "09:00", "Pacific/Apia").toISOString()
    ).toBe("2011-12-30T19:00:00.000Z")
  })
  it("clamps short months from the original anchor without drifting", () => {
    expect([0, 1, 2, 3].map((i) => recurrenceDate(schedule, i))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ])
    expect(
      recurrenceDate({ ...schedule, firstDue: "2024-02-29", unit: "year" }, 4)
    ).toBe("2028-02-29")
  })
  it("finds the next future instant across downtime and exact boundaries", () => {
    const daily = { ...schedule, firstDue: "2026-03-22", unit: "day" as const }
    expect(nextRecurrenceIndex(daily, new Date("2026-03-29T01:30:00Z"))).toBe(8)
    expect(nextRecurrenceIndex(daily, new Date("2026-03-29T01:29:59Z"))).toBe(7)
    expect(
      nextRecurrenceIndex(
        { ...daily, firstDue: "2000-01-01" },
        new Date("2026-01-01T10:00:00Z")
      )
    ).toBeGreaterThan(9000)
  })
})

it("recognizes only dates in the original skipped cadence", () => {
  expect(recurrenceIndexOnDate(schedule, "2026-02-28")).toBe(1)
  expect(recurrenceIndexOnDate(schedule, "2026-03-31")).toBe(2)
  expect(recurrenceIndexOnDate(schedule, "2026-03-28")).toBeNull()
  expect(
    recurrenceIndexOnDate(
      { ...schedule, firstDue: "2026-01-01", unit: "week" },
      "2026-01-02"
    )
  ).toBeNull()
  expect(
    recurrenceIndexOnDate(
      { ...schedule, firstDue: "2026-01-01", unit: "week" },
      "2026-01-08"
    )
  ).toBe(1)
})
