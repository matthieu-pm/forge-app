import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  canonicalIssueState,
  mergeCanonicalIssueRecords,
  replaceCanonicalIssues,
  suppressCanonicalIssueRecord,
} from "./canonical-issue-cache"
import {
  invalidateIssueQueries,
  useIssueQuery,
  useQueriedIssue,
} from "./issue-query-client"
import { loadIssueDetail, loadIssueQuery } from "./canonical-issue-state"
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
  vi.mocked(loadIssueDetail).mockReset()
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

it("keeps the open editor mounted through metadata refresh while revalidating its detail", async () => {
  const id = crypto.randomUUID()
  let finish!: (value: string) => void
  vi.mocked(loadIssueDetail)
    .mockResolvedValueOnce(JSON.stringify(page(id).records))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  function Detail() {
    const record = useQueriedIssue(id)
    return record ? <input aria-label="Private comment draft" /> : null
  }
  render(<Detail />)
  const editor = await screen.findByLabelText("Private comment draft")
  fireEvent.change(editor, {
    target: { value: "Keep selected evidence and text" },
  })
  act(() => replaceCanonicalIssues(structuredClone(identity)))
  await waitFor(() => expect(loadIssueDetail).toHaveBeenCalledTimes(2))
  expect(screen.getByLabelText("Private comment draft")).toBe(editor)
  expect((editor as HTMLInputElement).value).toBe(
    "Keep selected evidence and text"
  )
  await act(async () => finish(JSON.stringify(page(id).records)))
  expect(screen.getByLabelText("Private comment draft")).toBe(editor)
})

it.each(["empty", "failure"])(
  "hides the retained detail after a confirmed %s revalidation",
  async (outcome) => {
    const id = crypto.randomUUID()
    vi.mocked(loadIssueDetail).mockResolvedValueOnce(
      JSON.stringify(page(id).records)
    )
    const hook = renderHook(() => useQueriedIssue(id))
    await waitFor(() => expect(hook.result.current?.issue.id).toBe(id))
    if (outcome === "empty")
      vi.mocked(loadIssueDetail).mockResolvedValueOnce("[]")
    else
      vi.mocked(loadIssueDetail).mockRejectedValueOnce(
        new Error("Access revoked")
      )
    act(() => invalidateIssueQueries())
    await waitFor(() => expect(hook.result.current).toBeUndefined())
  }
)

it("immediately hides another identity's detail and ignores its late refresh", async () => {
  const id = crypto.randomUUID()
  let finish!: (value: string) => void
  vi.mocked(loadIssueDetail)
    .mockResolvedValueOnce(JSON.stringify(page(id).records))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce("[]")
  const hook = renderHook(() => useQueriedIssue(id))
  await waitFor(() => expect(hook.result.current?.issue.id).toBe(id))
  act(() => invalidateIssueQueries())
  await waitFor(() => expect(loadIssueDetail).toHaveBeenCalledTimes(2))
  act(() =>
    replaceCanonicalIssues({
      ...identity,
      userId: "bob",
      sessionId: "session-b",
    })
  )
  expect(hook.result.current).toBeUndefined()
  await act(async () => finish(JSON.stringify(page(id).records)))
  expect(hook.result.current).toBeUndefined()
})

it("immediately hides a known deleted detail while its revalidation is pending", async () => {
  const id = crypto.randomUUID()
  vi.mocked(loadIssueDetail).mockResolvedValueOnce(
    JSON.stringify(page(id).records)
  )
  const hook = renderHook(() => useQueriedIssue(id))
  await waitFor(() => expect(hook.result.current?.issue.id).toBe(id))
  vi.mocked(loadIssueDetail).mockReturnValueOnce(new Promise(() => {}))
  act(() => {
    suppressCanonicalIssueRecord(id, 1)
    invalidateIssueQueries()
  })
  expect(hook.result.current).toBeUndefined()
})

it("ignores a failed obsolete revalidation when a newer refresh is pending", async () => {
  const id = crypto.randomUUID()
  let reject!: (error: Error) => void
  let finish!: (value: string) => void
  vi.mocked(loadIssueDetail)
    .mockResolvedValueOnce(JSON.stringify(page(id).records))
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  const hook = renderHook(() => useQueriedIssue(id))
  await waitFor(() => expect(hook.result.current?.issue.id).toBe(id))
  act(() => invalidateIssueQueries())
  await waitFor(() => expect(loadIssueDetail).toHaveBeenCalledTimes(2))
  await act(async () => {
    invalidateIssueQueries()
    reject(new Error("Obsolete failure"))
    await Promise.resolve()
  })
  expect(hook.result.current?.issue.id).toBe(id)
  await act(async () => finish(JSON.stringify(page(id).records)))
  expect(hook.result.current?.issue.id).toBe(id)
})

describe("FOR-51 personal queue cache revocation", () => {
  it.each(["assigned", "created", "subscribed"] as const)(
    "an explicit %s refresh purges the cached row and retained detail even if the new page is empty",
    async (personal) => {
      const id = crypto.randomUUID()
      vi.mocked(loadIssueQuery).mockResolvedValueOnce(JSON.stringify(page(id)))
      vi.mocked(loadIssueDetail).mockResolvedValueOnce(
        JSON.stringify(page(id).records)
      )
      const queue = renderHook(() => useIssueQuery({ personal }))
      const detail = renderHook(() => useQueriedIssue(id))
      await waitFor(() => expect(queue.result.current.records).toHaveLength(1))
      await waitFor(() => expect(detail.result.current?.issue.id).toBe(id))
      vi.mocked(loadIssueQuery).mockResolvedValue(
        JSON.stringify({ ...page(id), records: [], total: 0 })
      )
      vi.mocked(loadIssueDetail).mockResolvedValue("[]")
      act(() => queue.result.current.refresh())
      expect(detail.result.current).toBeUndefined()
      expect(canonicalIssueState()?.records).toEqual([])
      await waitFor(() => expect(queue.result.current.page?.total).toBe(0))
      expect(queue.result.current.records).toEqual([])
      expect(canonicalIssueState()?.records).toEqual([])
    }
  )

  it.each(["empty", "failure"])(
    "a %s detail revalidation evicts all cached personal tabs, fences delayed reads and recovers after access returns",
    async (outcome) => {
      const id = crypto.randomUUID()
      vi.mocked(loadIssueQuery).mockResolvedValue(JSON.stringify(page(id)))
      vi.mocked(loadIssueDetail).mockResolvedValue(
        JSON.stringify(page(id).records)
      )
      const assigned = renderHook(() => useIssueQuery({ personal: "assigned" }))
      const subscribed = renderHook(() =>
        useIssueQuery({ personal: "subscribed" })
      )
      const detail = renderHook(() => useQueriedIssue(id))
      const secondDetail = renderHook(() => useQueriedIssue(id))
      await waitFor(() =>
        expect(assigned.result.current.records).toHaveLength(1)
      )
      await waitFor(() =>
        expect(subscribed.result.current.records).toHaveLength(1)
      )
      await waitFor(() =>
        expect(secondDetail.result.current?.issue.id).toBe(id)
      )
      let finishOld!: (value: string) => void
      let deny!: () => void
      // Queue reads began before the denial; returning them later must not
      // restore rows or counts. Keep the second detail request pending too.
      vi.mocked(loadIssueQuery)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = resolve
            })
        )
        .mockResolvedValue(
          JSON.stringify({ ...page(id), records: [], total: 0 })
        )
      vi.mocked(loadIssueDetail)
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              deny = () =>
                outcome === "empty"
                  ? resolve("[]")
                  : reject(new Error("revoked"))
            })
        )
        .mockReturnValueOnce(new Promise(() => {}))
      act(() => invalidateIssueQueries())
      await waitFor(() => expect(loadIssueDetail).toHaveBeenCalledTimes(4))
      await act(async () => deny())
      expect(detail.result.current).toBeUndefined()
      expect(secondDetail.result.current).toBeUndefined()
      expect(canonicalIssueState()?.records).toEqual([])
      await act(async () => finishOld(JSON.stringify(page(id))))
      await waitFor(() => expect(assigned.result.current.loading).toBe(false))
      expect(assigned.result.current.page?.total).toBe(0)
      expect(subscribed.result.current.records).toEqual([])
      expect(canonicalIssueState()?.records).toEqual([])

      // Access may be restored without changing the issue revision.
      vi.mocked(loadIssueQuery).mockResolvedValue(JSON.stringify(page(id)))
      vi.mocked(loadIssueDetail).mockResolvedValue(
        JSON.stringify(page(id).records)
      )
      act(() => invalidateIssueQueries())
      await waitFor(() =>
        expect(assigned.result.current.records).toHaveLength(1)
      )
      await waitFor(() => expect(detail.result.current?.issue.id).toBe(id))
      await waitFor(() =>
        expect(secondDetail.result.current?.issue.id).toBe(id)
      )
    }
  )
})

it.each(["empty", "failure"])(
  "FOR-51 review: invalidation clears cached private rows after a replacement %s without an open detail",
  async (outcome) => {
    const id = crypto.randomUUID()
    vi.mocked(loadIssueQuery).mockResolvedValueOnce(JSON.stringify(page(id)))
    const queue = renderHook(() => useIssueQuery({ personal: "assigned" }))
    await waitFor(() => expect(queue.result.current.records).toHaveLength(1))
    expect(canonicalIssueState()?.records).toHaveLength(1)
    if (outcome === "empty")
      vi.mocked(loadIssueQuery).mockResolvedValueOnce(
        JSON.stringify({ ...page(id), records: [], total: 0 })
      )
    else vi.mocked(loadIssueQuery).mockRejectedValueOnce(new Error("revoked"))
    act(() => invalidateIssueQueries([team]))
    await waitFor(() => expect(queue.result.current.loading).toBe(false))
    expect(queue.result.current.records).toEqual([])
    expect(canonicalIssueState()?.records).toEqual([])
    // An acknowledgement from before invalidation cannot refill the cache.
    act(() => mergeCanonicalIssueRecords(page(id).records))
    expect(canonicalIssueState()?.records).toEqual([])
    expect(loadIssueDetail).not.toHaveBeenCalled()
  }
)

it("FOR-51 review: mutation invalidation retains its committed record and mounted editor while discarding other cached details", async () => {
  const id = crypto.randomUUID()
  const original = page(id).records[0]
  vi.mocked(loadIssueDetail)
    .mockResolvedValueOnce(JSON.stringify([original]))
    .mockReturnValueOnce(new Promise(() => {}))
  function Detail() {
    const record = useQueriedIssue(id)
    return record ? (
      <>
        <input aria-label="Retained mutation draft" />
        <span>{record.issue.title}</span>
      </>
    ) : null
  }
  render(<Detail />)
  const editor = await screen.findByLabelText("Retained mutation draft")
  fireEvent.change(editor, {
    target: { value: "Unsent text and uploads stay here" },
  })
  const other = page(crypto.randomUUID()).records[0]
  const unrelated = {
    ...page(crypto.randomUUID()).records[0],
    teamId: crypto.randomUUID(),
  }
  act(() => mergeCanonicalIssueRecords([other, unrelated], false))
  const updated = {
    ...original,
    issue: { ...original.issue, title: "Committed title", revision: 2 },
  }
  act(() => mergeCanonicalIssueRecords([updated]))
  await waitFor(() => expect(loadIssueDetail).toHaveBeenCalledTimes(2))
  expect(screen.getByLabelText("Retained mutation draft")).toBe(editor)
  expect((editor as HTMLInputElement).value).toBe(
    "Unsent text and uploads stay here"
  )
  expect(screen.getByText("Committed title")).toBeTruthy()
  expect(
    canonicalIssueState()
      ?.records.map((r) => r.issue.id)
      .sort()
  ).toEqual([id, unrelated.issue.id].sort())
})

it("FOR-51 review: metadata-only replacement fences delayed mutation records until a fresh authorized read", async () => {
  const id = crypto.randomUUID()
  const record = page(id).records[0]
  act(() => mergeCanonicalIssueRecords([record], false))
  act(() => replaceCanonicalIssues(structuredClone(identity)))
  act(() => mergeCanonicalIssueRecords([record]))
  expect(canonicalIssueState()?.records).toEqual([])
  vi.mocked(loadIssueDetail).mockResolvedValueOnce(JSON.stringify([record]))
  const detail = renderHook(() => useQueriedIssue(id))
  await waitFor(() => expect(detail.result.current?.issue.id).toBe(id))
  expect(canonicalIssueState()?.records).toEqual([record])
})
