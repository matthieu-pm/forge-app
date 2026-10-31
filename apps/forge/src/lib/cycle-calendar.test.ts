import { describe, expect, it } from "vitest"
import { addCycleDays, cycleToday, nextCycleDate } from "./cycle-calendar"

describe("cycle calendar dates", () => {
  it("uses the shared timezone across viewers and DST", () => {
    const instant = new Date("2026-03-29T22:30:00Z")
    expect(cycleToday("Europe/Paris", instant)).toBe("2026-03-30")
    expect(cycleToday("America/Los_Angeles", instant)).toBe("2026-03-29")
    expect(addCycleDays("2026-03-23", 13)).toBe("2026-04-05")
    expect(addCycleDays("2026-10-19", 13)).toBe("2026-11-01")
  })
  it("starts strictly after today and aligns new settings after the last window", () => {
    expect(nextCycleDate("2026-11-02", 1)).toBe("2026-11-09")
    expect(nextCycleDate("2026-11-02", 1, false)).toBe("2026-11-02")
    expect(nextCycleDate("2026-11-03", 1, false)).toBe("2026-11-09")
  })
})
