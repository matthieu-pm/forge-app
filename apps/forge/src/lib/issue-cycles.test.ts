import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cycleIssuesKey, useCycleIssues } from "./cycle-issues"
import {
  blankIssueDraft,
  moveTeamIssue,
  readIssueStore,
  saveTeamIssue,
} from "./team-issues"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import { initialTeamCycles, scheduledTeamCycles } from "./team-cycles"
import { productStorage } from "@/lib/product-storage"

const team = "cycle-assignments"
const cycle = "2026-11-02"
beforeEach(() => productStorage.clear())
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
    expect(productStorage.getItem(cycleIssuesKey(team))).toBeNull()
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
    productStorage.setItem(
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
  it("keeps canonical row properties and promotes edited legacy records without changing their snapshots", () => {
    const canonical = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Linked work",
      cycle,
      project: "Release",
      labels: "Bug",
      assignee: "member",
    })
    const legacy = {
      id: "legacy",
      number: 9,
      title: "Older work",
      description: "Brief",
      cycle,
      status: canonical.status,
      priority: "No priority",
      createdAt: new Date().toISOString(),
    }
    const snapshot = JSON.stringify([legacy])
    productStorage.setItem(cycleIssuesKey(team), snapshot)
    const { result } = renderHook(() => useCycleIssues(team, cycle))
    expect(
      result.current.records.find((issue) => issue.id === canonical.id)
    ).toMatchObject({ project: "Release", labels: "Bug", assignee: "member" })
    expect(
      result.current.records.find((issue) => issue.id === legacy.id)
    ).toMatchObject({
      description: "Brief",
      parentId: "",
      comments: [],
      dueDate: "",
    })
    act(() => {
      result.current.patch([canonical.id, legacy.id], { priority: "High" })
    })
    expect(readIssueStore(team).issues).toHaveLength(2)
    expect(
      readIssueStore(team).issues.every((issue) => issue.priority === "High")
    ).toBe(true)
    expect(productStorage.getItem(cycleIssuesKey(team))).toBe(snapshot)
    act(() => {
      result.current.patch([legacy.id], { cycle: "" })
    })
    expect(result.current.records.map((issue) => issue.id)).toEqual([
      canonical.id,
    ])
  })
  it("keeps mixed selections atomic when saving fails or an issue has moved", () => {
    const first = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "First",
      cycle,
    })
    const second = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Second",
      cycle,
    })
    const { result } = renderHook(() => useCycleIssues(team, cycle))
    const write = vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(() =>
      result.current.patch([first.id, second.id], { priority: "High" })
    ).toThrow()
    expect(
      readIssueStore(team).issues.every(
        (issue) => issue.priority === "No priority"
      )
    ).toBe(true)
    write.mockRestore()
    act(() => {
      saveTeamIssue(team, { ...second, cycle: "other" }, { id: second.id })
    })
    expect(() =>
      result.current.patch([first.id, second.id], { priority: "High" })
    ).toThrow("no longer")
    expect(readIssueStore(team).issues[0].priority).toBe("No priority")
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
  it("renders canonical IDs without resurrecting legacy cycle-only snapshots", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Canonical imported work",
      cycle,
    })
    productStorage.setItem(
      cycleIssuesKey(team),
      JSON.stringify([
        { ...issue, id: "old-cycle-only-id", title: "Old snapshot" },
      ])
    )
    const state = {
      workspaceId: "workspace",
      userId: "member",
      sessionId: "session",
      projects: [],
      cycles: [],
      records: [{ teamId: team, legacyId: "old-cycle-only-id", issue }],
    }
    replaceCanonicalIssues(state)
    try {
      const { result } = renderHook(() => useCycleIssues(team, cycle))
      expect(result.current.records.map((i) => i.id)).toEqual([issue.id])
      act(() =>
        replaceCanonicalIssues({
          ...state,
          records: [
            {
              ...state.records[0],
              issue: { ...issue, cycle: "", revision: 1 },
            },
          ],
        })
      )
      expect(result.current.records).toHaveLength(0)
      expect(productStorage.getItem(cycleIssuesKey(team))).toContain(
        "Old snapshot"
      )
    } finally {
      replaceCanonicalIssues(null, false)
    }
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
