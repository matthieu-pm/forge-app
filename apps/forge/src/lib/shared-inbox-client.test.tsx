import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { publishInboxUpdate, useInbox } from "./inbox-state"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import { invalidatePreferenceSession } from "./preference-session-events"
import { loadSharedInbox } from "./shared-inbox-functions"
import type { SharedInboxPage } from "./shared-inbox-contract"
import { scope, update } from "@/components/inbox/inbox-test-fixtures"

vi.mock("./shared-inbox-functions", () => ({ loadSharedInbox: vi.fn() }))
const page = (
  title = "Server authorized",
  userId = scope.userId,
  sessionId = "session"
): SharedInboxPage => ({
  ...scope,
  userId,
  sessionId,
  nextCursor: null,
  entries: [
    {
      id: "issue:authorized",
      issue: { ...update().issue, id: "authorized", title },
      events: [
        {
          ...update(),
          id: "committed",
          kind: "mention",
          createdAt: "2026-11-05T10:00:00.000001Z",
          message: "Committed activity",
        },
      ],
    },
  ],
})
function identity(userId = scope.userId, sessionId = "session") {
  replaceCanonicalIssues({
    ...scope,
    userId,
    sessionId,
    records: [],
    projects: [],
    cycles: [],
  })
}
beforeEach(() => {
  vi.mocked(loadSharedInbox).mockReset()
  localStorage.clear()
  invalidatePreferenceSession("settled")
  identity()
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null, false)
})

it("canonical inbox ignores forged client publish and persists only device action metadata", async () => {
  vi.mocked(loadSharedInbox).mockResolvedValue(page())
  publishInboxUpdate(
    scope,
    update({ issue: { ...update().issue, title: "FORGED CLIENT" } })
  )
  const { result } = renderHook(() => useInbox(scope))
  await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
  expect(result.current.state.entries[0].issue?.title).toBe("Server authorized")
  act(() =>
    result.current.dispatch({
      type: "read",
      ids: ["issue:authorized"],
      unread: false,
    })
  )
  expect(result.current.state.entries[0].unread).toBe(false)
  const saved = localStorage.getItem(
    `forge:inbox-local-state:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`
  )!
  expect(saved).toContain("readThrough")
  expect(saved).not.toContain("Server authorized")
  expect(saved).not.toContain("Committed activity")
})

it("session invalidation clears content immediately and fences a delayed response", async () => {
  let resolve!: (value: SharedInboxPage) => void
  vi.mocked(loadSharedInbox).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const { result } = renderHook(() => useInbox(scope))
  await waitFor(() => expect(loadSharedInbox).toHaveBeenCalledOnce())
  act(() => invalidatePreferenceSession("start"))
  await act(() => resolve(page("PRIVATE LATE RESPONSE")))
  expect(result.current.state.entries).toEqual([])
  expect(loadSharedInbox).toHaveBeenCalledOnce()
})

it("refresh failure discards previously authorized private content", async () => {
  vi.mocked(loadSharedInbox).mockResolvedValueOnce(page("PRIVATE"))
  const { result } = renderHook(() => useInbox(scope))
  await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
  vi.mocked(loadSharedInbox).mockRejectedValue(new Error("revoked"))
  act(() => result.current.refresh())
  await waitFor(() =>
    expect(result.current.error).toContain("could not be loaded")
  )
  expect(result.current.state.entries).toEqual([])
})

it("failed device writes preserve unread state and report the failed action", async () => {
  vi.mocked(loadSharedInbox).mockResolvedValue(page())
  const { result } = renderHook(() => useInbox(scope))
  await waitFor(() => expect(result.current.state.entries).toHaveLength(1))
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable")
  })
  act(() => {
    expect(() =>
      result.current.dispatch({
        type: "read",
        ids: ["issue:authorized"],
        unread: false,
      })
    ).toThrow("could not be saved")
  })
  expect(result.current.state.entries[0].unread).toBe(true)
  expect(result.current.error).toContain("could not be saved")
})

it("account switches cannot restore a previous account response", async () => {
  let resolve!: (value: SharedInboxPage) => void
  vi.mocked(loadSharedInbox).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const { result } = renderHook(() => useInbox(scope))
  await waitFor(() => expect(loadSharedInbox).toHaveBeenCalledOnce())
  act(() => identity("other-user", "other-session"))
  await act(() => resolve(page("OTHER ACCOUNT PRIVATE")))
  expect(result.current.state.entries).toEqual([])
})

it("older pages merge once per issue without replacing the newest snapshot", async () => {
  const first = { ...page("Newest snapshot"), nextCursor: "older" }
  const older = page("Newest snapshot")
  older.entries[0].events = [
    {
      ...older.entries[0].events[0],
      id: "older",
      createdAt: "2026-11-04T10:00:00.000001Z",
    },
  ]
  vi.mocked(loadSharedInbox)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(older)
  const { result } = renderHook(() => useInbox(scope))
  await waitFor(() => expect(result.current.hasMore).toBe(true))
  act(() => result.current.loadMore())
  await waitFor(() =>
    expect(result.current.state.entries[0].events).toHaveLength(2)
  )
  expect(result.current.state.entries).toHaveLength(1)
  expect(result.current.state.entries[0].events.map((e) => e.id)).toEqual([
    "older",
    "committed",
  ])
  expect(result.current.hasMore).toBe(false)
})
