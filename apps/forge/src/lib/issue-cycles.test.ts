import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cycleIssuesKey, useCycleIssues } from "./cycle-issues"
import {
  blankIssueDraft,
  moveTeamIssue,
  readIssueStore,
  saveTeamIssue,
} from "./team-issues"
import { initialTeamCycles, scheduledTeamCycles } from "./team-cycles"

const team = "cycle-assignments"
const cycle = "2026-11-02"
beforeEach(() => localStorage.clear())
afterEach(cleanup)
describe("Issue cycle assignments", () => {
  it("persists assignments and changes cycle membership without duplicating an issue", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Plan",
      assignee: "member",
    })
    const { result } = renderHook(() => useCycleIssues(team, cycle))
    expect(result.current.issues).toHaveLength(0)
    act(() => {
      saveTeamIssue(team, { ...issue, cycle }, { id: issue.id })
    })
    expect(result.current.issues.map((value) => value.id)).toEqual([issue.id])
    expect(readIssueStore(team).issues[0].activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "cycle", from: "", to: cycle }),
      ])
    )
    act(() => {
      result.current.save(
        {
          ...result.current.issues[0],
          title: "Planned work",
          priority: "High",
        },
        issue.id
      )
    })
    expect(readIssueStore(team).issues[0]).toMatchObject({
      id: issue.id,
      title: "Planned work",
      cycle,
      priority: "High",
      assignee: "member",
    })
    expect(localStorage.getItem(cycleIssuesKey(team))).toBeNull()
    act(() => {
      const current = readIssueStore(team).issues[0]
      saveTeamIssue(team, { ...current, cycle: "" }, { id: issue.id })
    })
    expect(result.current.issues).toHaveLength(0)
    expect(readIssueStore(team).issues).toHaveLength(1)
  })
  it("combines existing cycle-only issues with assigned issues and isolates other teams and dates", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Canonical",
      cycle,
    })
    saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Later",
      cycle: "2026-11-30",
    })
    saveTeamIssue("other", { ...blankIssueDraft(), title: "Other team", cycle })
    const legacy = {
      id: "legacy",
      number: 3,
      title: "Existing cycle issue",
      description: "",
      cycle,
      status: issue.status,
      priority: "No priority",
      createdAt: new Date().toISOString(),
    }
    localStorage.setItem(
      cycleIssuesKey(team),
      JSON.stringify([
        legacy,
        { ...legacy, id: issue.id, title: "Old duplicate" },
      ])
    )
    const { result } = renderHook(() => useCycleIssues(team, cycle))
    expect(result.current.issues.map((value) => value.title)).toEqual([
      "Existing cycle issue",
      "Canonical",
    ])
  })
  it("clears assignments when moving issues to another team", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Move",
      cycle,
    })
    moveTeamIssue(team, "other", issue.id)
    expect(readIssueStore("other").issues[0].cycle).toBe("")
    expect(readIssueStore(team).issues).toHaveLength(0)
  })
  it("uses the same schedule and cooldown as cycle planning", () => {
    const dates = scheduledTeamCycles(
      {
        ...initialTeamCycles(),
        enabled: true,
        duration: 2,
        cooldown: 1,
        futureCycles: 2,
        startDay: 1,
      },
      new Date(2026, 9, 27)
    )
    expect(dates.map((value) => value.value)).toEqual([
      "2026-11-02",
      "2026-11-23",
    ])
    expect(dates[0].end.getDate()).toBe(15)
  })
})
