import { describe, expect, it } from "vitest"
import { matchesTriageFilters } from "./triage-filters"
import type { TriageFilter } from "./triage-filters"
import type { TriageIssue } from "./triage-issues"

const issue: TriageIssue = {
  id: "1",
  number: 1,
  title: "Broken link",
  description: "See https://example.com",
  priority: "High",
  dueDate: "2026-10-10",
  createdAt: "2026-10-12T12:00:00.000Z",
  snoozed: false,
  labels: "Bug, Website",
  project: "Launch",
  assignee: "alex",
}
const rule = (
  field: TriageFilter["field"],
  operator: TriageFilter["operator"],
  value = ""
): TriageFilter => ({ id: "test", field, operator, value })
describe("triage filters", () => {
  it("matches all or any conditions without changing issues", () => {
    const rules = [
      rule("priority", "is", "High"),
      rule("project", "is", "Other"),
    ]
    expect(matchesTriageFilters(issue, { match: "all", rules })).toBe(false)
    expect(matchesTriageFilters(issue, { match: "any", rules })).toBe(true)
    expect(matchesTriageFilters(issue, { match: "any", rules: [] })).toBe(true)
    expect(issue.project).toBe("Launch")
  })
  it("matches complete labels and ignores case and surrounding whitespace", () => {
    expect(
      matchesTriageFilters(issue, {
        match: "all",
        rules: [rule("labels", "is", " bug ")],
      })
    ).toBe(true)
    expect(
      matchesTriageFilters(issue, {
        match: "all",
        rules: [rule("labels", "is", "Web")],
      })
    ).toBe(false)
  })
  it("supports empty values, content and links", () => {
    expect(
      matchesTriageFilters(issue, {
        match: "all",
        rules: [
          rule("templateName", "notSet"),
          rule("content", "contains", "BROKEN"),
          rule("links", "set"),
        ],
      })
    ).toBe(true)
    expect(
      matchesTriageFilters(
        { ...issue, description: "" },
        { match: "all", rules: [rule("links", "notSet")] }
      )
    ).toBe(true)
  })
  it("compares calendar dates and excludes missing dates from overdue matches", () => {
    const filters = {
      match: "all" as const,
      rules: [rule("dueDate", "before", "2026-10-12")],
    }
    expect(matchesTriageFilters(issue, filters)).toBe(true)
    expect(matchesTriageFilters({ ...issue, dueDate: "" }, filters)).toBe(false)
    expect(
      matchesTriageFilters(issue, {
        match: "all",
        rules: [rule("createdAt", "is", "2026-10-12")],
      })
    ).toBe(true)
  })
})
