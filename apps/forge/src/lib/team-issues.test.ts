import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  blankIssueDraft,
  defaultIssueDisplay,
  emptyIssueFilters,
  initialIssueStore,
  matchesIssueFilters,
  parseIssueStore,
  readIssueStore,
  saveIssueDraft,
  saveTeamIssue,
  teamIssuesKey,
  visibleIssues,
  writeIssueStore,
} from "./team-issues"
import { initialTeamStatuses } from "./team-statuses"

const team = "issue-page-tests"
const statuses = initialTeamStatuses().statuses
beforeEach(() => localStorage.clear())
describe("team issues", () => {
  it("creates children atomically with unique numbers and consumes a draft", () => {
    const draft = {
      ...blankIssueDraft(),
      title: "Parent",
      subIssues: ["Child"],
    }
    const draftId = saveIssueDraft(team, draft)
    const parent = saveTeamIssue(team, draft, { draftId })
    const store = readIssueStore(team)
    expect(store.drafts).toEqual([])
    expect(store.issues.map((i) => i.number)).toEqual([1, 2])
    expect(store.issues[1].parentId).toBe(parent.id)
    expect(store.nextNumber).toBe(3)
  })
  it("moves issues between scopes without losing issue identity or contents", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Task",
      description: "Details",
    })
    saveTeamIssue(team, { ...issue, status: "backlog" }, { id: issue.id })
    const issues = readIssueStore(team).issues
    expect(
      visibleIssues(
        issues,
        "active",
        statuses,
        emptyIssueFilters(),
        defaultIssueDisplay()
      )
    ).toHaveLength(0)
    expect(
      visibleIssues(
        issues,
        "backlog",
        statuses,
        emptyIssueFilters(),
        defaultIssueDisplay()
      )[0]
    ).toMatchObject({ id: issue.id, number: 1, description: "Details" })
  })
  it("preserves stored data when validation or quota fails", () => {
    saveTeamIssue(team, { ...blankIssueDraft(), title: "Keep me" })
    const original = localStorage.getItem(teamIssuesKey(team))
    expect(() => saveTeamIssue(team, blankIssueDraft())).toThrow()
    expect(localStorage.getItem(teamIssuesKey(team))).toBe(original)
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    expect(() =>
      saveTeamIssue(team, { ...blankIssueDraft(), title: "Failed" })
    ).toThrow()
    set.mockRestore()
    expect(localStorage.getItem(teamIssuesKey(team))).toBe(original)
  })
  it("does not overwrite corrupted stores", () => {
    localStorage.setItem(teamIssuesKey(team), "invalid")
    expect(() => writeIssueStore(team, () => initialIssueStore())).toThrow()
    expect(localStorage.getItem(teamIssuesKey(team))).toBe("invalid")
  })
  it("filters labels exactly and combines all/any conditions", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Fix billing",
      labels: "Bug, Backend",
      priority: "High",
    })
    const rules = [
      {
        id: "a",
        field: "labels" as const,
        operator: "is" as const,
        value: "Bug",
      },
      {
        id: "b",
        field: "priority" as const,
        operator: "is" as const,
        value: "Low",
      },
    ]
    expect(matchesIssueFilters(issue, { match: "all", rules })).toBe(false)
    expect(matchesIssueFilters(issue, { match: "any", rules })).toBe(true)
    expect(
      matchesIssueFilters(issue, {
        match: "all",
        rules: [{ ...rules[0], value: "Back" }],
      })
    ).toBe(false)
  })
  it("sorts urgent work before unset priority and round-trips saved views", () => {
    saveTeamIssue(team, { ...blankIssueDraft(), title: "Unset" })
    saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Urgent",
      priority: "Urgent",
    })
    const store = writeIssueStore(team, (s) => ({
      ...s,
      views: [
        {
          id: "v",
          name: "My view",
          scope: "all",
          filters: emptyIssueFilters(),
          display: { ...defaultIssueDisplay(), layout: "board" },
        },
      ],
    }))
    expect(
      visibleIssues(
        store.issues,
        "all",
        statuses,
        emptyIssueFilters(),
        defaultIssueDisplay()
      )[0].title
    ).toBe("Urgent")
    expect(parseIssueStore(JSON.stringify(store)).views[0].display.layout).toBe(
      "board"
    )
  })
  it("spawns one recurring successor on completion and clamps month ends", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Monthly",
      recurrence: "monthly",
      dueDate: "2026-01-31",
    })
    const done = saveTeamIssue(
      team,
      { ...issue, status: "done" },
      { id: issue.id }
    )
    saveTeamIssue(team, { ...done, description: "Updated" }, { id: done.id })
    const issues = readIssueStore(team).issues
    expect(issues).toHaveLength(2)
    expect(issues[1]).toMatchObject({
      status: "todo",
      dueDate: "2026-02-28",
      recurrence: "monthly",
      completedAt: null,
    })
  })
  it("keeps teams isolated", () => {
    saveTeamIssue(team, { ...blankIssueDraft(), title: "Private to this team" })
    expect(readIssueStore("another-team").issues).toEqual([])
  })
})
