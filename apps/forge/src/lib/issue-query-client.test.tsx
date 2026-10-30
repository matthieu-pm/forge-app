import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import { invalidateIssueQueries, useIssueQuery } from "./issue-query-client"
import { loadIssueQuery } from "./canonical-issue-state"
import { blankIssueDraft } from "./issue-record-contract"
import type { IssueQueryPage } from "./issue-query-contract"

vi.mock("./canonical-issue-state", () => ({
  loadIssueQuery: vi.fn(),
  loadIssueDetail: vi.fn(),
}))
const team = "00000000-0000-4000-8000-000000000001"
const identity = {
  workspaceId: "workspace-a",
  userId: "alice",
  sessionId: "session-a",
  records: [],
  projects: [],
  cycles: [],
}
function page(id: string, nextCursor: string | null = null): IssueQueryPage {
  return {
    ...identity,
    resultRevision: "v1",
    records: [
      {
        teamId: team,
        issue: {
          ...blankIssueDraft(),
          id,
          number: 1,
          title: id,
          creator: "alice",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          statusChangedAt: "2026-01-01T00:00:00Z",
          suggestedLabel: "",
          completedAt: null,
          recurrenceSpawned: false,
        },
      },
    ],
    nextCursor,
    total: 3,
    facets: {
      assignee: [],
      labels: [],
      priority: [],
      project: [],
      team: [],
      status: [],
    },
    facetsTruncated: false,
    groups: [],
    rollups: [],
    projectTotals: [],
  }
}
beforeEach(() => {
  vi.mocked(loadIssueQuery).mockReset()
  replaceCanonicalIssues(structuredClone(identity))
  invalidateIssueQueries()
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null, false)
  invalidateIssueQueries()
})
describe("authorized query client", () => {
  it("loads one bounded page, explicitly continues and deduplicates a repeated row", async () => {
    vi.mocked(loadIssueQuery)
      .mockResolvedValueOnce(JSON.stringify(page("first", "cursor-a")))
      .mockResolvedValueOnce(JSON.stringify(page("first")))
    const hook = renderHook(() => useIssueQuery({ teamIds: [team] }))
    await waitFor(() => expect(hook.result.current.records).toHaveLength(1))
    expect(loadIssueQuery).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.loadMore())
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(vi.mocked(loadIssueQuery).mock.calls[1][0].data.query.cursor).toBe(
      "cursor-a"
    )
    expect(hook.result.current.records).toHaveLength(1)
    expect(hook.result.current.page?.total).toBe(3)
  })
  it("discards old-scope late responses and clears protected rows on failed refresh", async () => {
    let resolveOld!: (value: string) => void
    vi.mocked(loadIssueQuery).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const hook = renderHook(() => useIssueQuery({ teamIds: [team] }))
    await waitFor(() => expect(loadIssueQuery).toHaveBeenCalledTimes(1))
    vi.mocked(loadIssueQuery).mockResolvedValueOnce(
      JSON.stringify({
        ...page("bob"),
        workspaceId: "workspace-b",
        userId: "bob",
        sessionId: "session-b",
      })
    )
    act(() =>
      replaceCanonicalIssues({
        ...identity,
        workspaceId: "workspace-b",
        userId: "bob",
        sessionId: "session-b",
      })
    )
    await waitFor(() =>
      expect(hook.result.current.records[0]?.issue.title).toBe("bob")
    )
    await act(() => resolveOld(JSON.stringify(page("alice secret"))))
    expect(hook.result.current.records[0]?.issue.title).toBe("bob")
    vi.mocked(loadIssueQuery).mockRejectedValueOnce(new Error("revoked"))
    act(() => hook.result.current.refresh())
    await waitFor(() =>
      expect(hook.result.current.error).toContain("could not be loaded")
    )
    expect(hook.result.current.records).toEqual([])
  })
  it("removes previously loaded private rows when access is revoked between pages", async () => {
    vi.mocked(loadIssueQuery)
      .mockResolvedValueOnce(JSON.stringify(page("private", "next")))
      .mockResolvedValue(
        JSON.stringify({
          ...page("unused"),
          records: [],
          resultRevision: "v2",
          total: 0,
        })
      )
    const hook = renderHook(() => useIssueQuery({ teamIds: [team] }))
    await waitFor(() => expect(hook.result.current.records).toHaveLength(1))
    act(() => hook.result.current.loadMore())
    await waitFor(() => expect(hook.result.current.page?.total).toBe(0))
    expect(hook.result.current.records).toEqual([])
  })
  it("refreshes query totals and groups after a shared workflow or label definition changes", async () => {
    vi.mocked(loadIssueQuery).mockResolvedValue(JSON.stringify(page("shared")))
    const hook = renderHook(() => useIssueQuery({ teamIds: [team] }))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() =>
      window.dispatchEvent(new Event("forge:issue-definitions-changed"))
    )
    await waitFor(() => expect(loadIssueQuery).toHaveBeenCalledTimes(2))
  })
  it("invalidates the affected team without restarting unrelated queries", async () => {
    const other = "00000000-0000-4000-8000-000000000002"
    vi.mocked(loadIssueQuery).mockResolvedValue(JSON.stringify(page("shared")))
    const a = renderHook(() => useIssueQuery({ teamIds: [team] }))
    const b = renderHook(() => useIssueQuery({ teamIds: [other] }))
    await waitFor(() =>
      expect(a.result.current.loading || b.result.current.loading).toBe(false)
    )
    expect(loadIssueQuery).toHaveBeenCalledTimes(2)
    act(() => invalidateIssueQueries([team]))
    await waitFor(() => expect(loadIssueQuery).toHaveBeenCalledTimes(3))
    expect(
      vi.mocked(loadIssueQuery).mock.calls[2][0].data.query.teamIds
    ).toEqual([team])
  })
})
