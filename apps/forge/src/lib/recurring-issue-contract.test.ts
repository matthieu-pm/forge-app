import { describe, expect, it } from "vitest"
import {
  emptyRecurringIssue,
  formatDueDate,
  recurrenceLabel,
  recurringIssuePayloadSchema,
  saveRecurringIssueSchema,
} from "./recurring-issue-contract"

const teamId = "00000000-0000-4000-8000-000000000001"
const draft = {
  ...emptyRecurringIssue(
    teamId,
    "Europe/Paris",
    new Date("2026-10-11T20:00:00Z")
  ),
  title: "Weekly review",
}
describe("Recurring issue schedules", () => {
  it("defaults to next week in the team's timezone, including year boundaries", () => {
    expect(draft.firstDue).toBe("2026-10-18")
    expect(
      emptyRecurringIssue(
        teamId,
        "Pacific/Kiritimati",
        new Date("2026-12-31T12:00:00Z")
      ).firstDue
    ).toBe("2027-01-08")
    expect(
      emptyRecurringIssue(
        teamId,
        "America/Los_Angeles",
        new Date("2026-12-31T12:00:00Z")
      ).firstDue
    ).toBe("2027-01-07")
  })
  it.each(["", "2026-02-29", "2026-04-31", "2026-13-01", "2026-1-2"])(
    "rejects an invalid due date %s",
    (firstDue) => {
      expect(
        recurringIssuePayloadSchema.safeParse({ ...draft, firstDue }).success
      ).toBe(false)
    }
  )
  it.each([0, -1, 1.5, 101, NaN])(
    "rejects unsupported intervals %s",
    (interval) => {
      expect(
        recurringIssuePayloadSchema.safeParse({ ...draft, interval }).success
      ).toBe(false)
    }
  )
  it("accepts leap days and all recurrence units without shifting dates to the viewer timezone", () => {
    for (const unit of ["day", "week", "month", "year"])
      expect(
        recurringIssuePayloadSchema.safeParse({
          ...draft,
          firstDue: "2028-02-29",
          unit,
        }).success
      ).toBe(true)
    expect(formatDueDate("2028-02-29")).toBe("Feb 29, 2028")
    expect(recurrenceLabel(draft)).toBe("Every week")
    expect(recurrenceLabel({ interval: 2, unit: "month" })).toBe(
      "Every 2 months"
    )
  })
  it("validates titles, nested issues, and rich document URLs at the server boundary", () => {
    expect(
      saveRecurringIssueSchema.safeParse({
        slug: "testing",
        payload: { ...draft, title: "  " },
      }).success
    ).toBe(false)
    expect(
      recurringIssuePayloadSchema.safeParse({
        ...draft,
        content: {
          type: "doc",
          content: [{ type: "image", attrs: { src: "javascript:alert(1)" } }],
        },
      }).success
    ).toBe(false)
    expect(
      recurringIssuePayloadSchema.safeParse({
        ...draft,
        subIssues: [
          { id: "sub", title: "", content: null, properties: draft.properties },
        ],
      }).success
    ).toBe(false)
  })
})
