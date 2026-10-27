import { expect, it } from "vitest"
import { parseTargetDateInput } from "./target-dates"
import { targetLabel, targetTimestamp } from "./initiatives"

it("accepts the text formats shown in the target date picker", () => {
  expect(parseTargetDateInput("May 2027")).toBe("2027-05")
  expect(parseTargetDateInput("Q4", 2026)).toBe("2026-Q4")
  expect(parseTargetDateInput("Q2 2027")).toBe("2027-Q2")
  expect(parseTargetDateInput("05/20/2027")).toBe("2027-05-20")
  expect(parseTargetDateInput("02/30/2027")).toBeNull()
  expect(parseTargetDateInput("H2 2027")).toBe("2027-H2")
  expect(targetLabel("2027-H2")).toBe("H2 2027")
  expect(targetTimestamp("2027-H1")).toBe(Date.UTC(2027, 5, 30, 23, 59, 59))
})
