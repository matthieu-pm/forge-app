import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useTeamResources } from "./team-resources-client"
import { loadTeamResources, persistTeamResources } from "./team-resources-state"
import {
  initializeProductStorage,
  resetProductStorage,
} from "./product-storage"
import { retireProtectedSession } from "./protected-session"
import { recoveredTeamResources } from "./team-resources-journal"

vi.mock("./team-resources-state", () => ({
  loadTeamResources: vi.fn(),
  persistTeamResources: vi.fn(),
}))
vi.mock("./product-state-server", () => ({
  loadProductState: vi.fn(),
  persistProductState: vi.fn(),
}))
const teamId = "ccf1441f-15df-44b9-ac4b-09440dd1f00a",
  otherTeamId = "e00f2c19-ed57-41e1-9010-579f02c045d3"
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "session",
  entries: [],
}
const board = (title = "Public reference") => ({
  revision: 0,
  sections: [],
  links: [{ id: teamId, title, url: "https://example.com/", sectionId: null }],
  order: [],
})
beforeEach(() => {
  localStorage.clear()
  initializeProductStorage(identity, false)
  vi.mocked(loadTeamResources).mockResolvedValue(JSON.stringify(board()))
  vi.mocked(persistTeamResources).mockReset()
})
afterEach(() => {
  cleanup()
  resetProductStorage()
  vi.clearAllMocks()
})
describe("authorized shared-resource client", () => {
  it("ignores a late response from the previous team", async () => {
    let release!: (value: string) => void
    vi.mocked(loadTeamResources).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const hook = renderHook(({ id }) => useTeamResources(id), {
      initialProps: { id: teamId },
    })
    hook.rerender({ id: otherTeamId })
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    await act(async () =>
      release(JSON.stringify(board("Old private resource")))
    )
    expect(hook.result.current.snapshot.links[0].title).toBe("Public reference")
  })
  it("ignores both late successes and failures after protected-session retirement", async () => {
    let release!: (value: string) => void
    vi.mocked(loadTeamResources).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const hook = renderHook(() => useTeamResources(teamId))
    await act(async () => {
      retireProtectedSession()
      initializeProductStorage(
        { ...identity, userId: "bob", sessionId: "new-session" },
        false
      )
      release(JSON.stringify(board("Alice secret")))
    })
    expect(hook.result.current.snapshot.links).toEqual([])
    expect(hook.result.current.ready).toBe(false)
  })
  it("recovers and retries the exact uncertain command after remount", async () => {
    vi.mocked(persistTeamResources).mockRejectedValueOnce(
      new Error("Connection lost")
    )
    let hook = renderHook(() => useTeamResources(teamId))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    const fields = { sections: [], links: [], order: [] }
    await act(async () => {
      await expect(hook.result.current.save(fields)).rejects.toThrow(
        "Connection lost"
      )
    })
    const first = vi.mocked(persistTeamResources).mock.calls[0][0]
    expect(recoveredTeamResources(identity, teamId)).not.toBeNull()
    hook.unmount()
    hook = renderHook(() => useTeamResources(teamId))
    await waitFor(() => expect(hook.result.current.pending).not.toBeNull())
    vi.mocked(persistTeamResources).mockResolvedValueOnce(
      JSON.stringify({ status: "saved", revision: 1 })
    )
    await act(async () => {
      expect(await hook.result.current.retry()).toBe(true)
    })
    expect(vi.mocked(persistTeamResources).mock.calls[1][0]).toEqual(first)
    expect(recoveredTeamResources(identity, teamId)).toBeNull()
  })
  it("keeps conflicting proposals until explicit latest-version review", async () => {
    vi.mocked(persistTeamResources).mockResolvedValueOnce(
      JSON.stringify({
        status: "conflict",
        current: { ...board("Latest saved link"), revision: 2 },
      })
    )
    const hook = renderHook(() => useTeamResources(teamId))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    await act(async () => {
      expect(
        await hook.result.current.save({ sections: [], links: [], order: [] })
      ).toBe(false)
    })
    expect(hook.result.current.conflict).toBe(true)
    expect(hook.result.current.snapshot.links[0].title).toBe(
      "Latest saved link"
    )
    expect(recoveredTeamResources(identity, teamId)).not.toBeNull()
    act(() => hook.result.current.reviewConflict())
    expect(hook.result.current.pending).toBeNull()
    expect(recoveredTeamResources(identity, teamId)).toBeNull()
  })
  it("evicts protected content after a denied refresh", async () => {
    const hook = renderHook(() => useTeamResources(teamId))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    vi.mocked(loadTeamResources).mockRejectedValueOnce(
      new Error("Access denied")
    )
    await act(async () => {
      await hook.result.current.refresh()
    })
    expect(hook.result.current.snapshot.links).toEqual([])
    expect(hook.result.current.error).toBe("Access denied")
  })
})
