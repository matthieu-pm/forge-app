import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useSharedTeamCycles } from "./shared-cycle-client"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import { initialTeamCycles } from "./team-cycles-contract"
import type { SharedCycleSnapshot } from "./team-cycles-contract"

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock("./cycle-state", () => ({ loadSharedTeamCycles: mocks.load }))
vi.mock("./product-state-server", () => ({ persistProductState: mocks.save }))
let snapshot: SharedCycleSnapshot
function identity(workspaceId = "workspace") {
  replaceCanonicalIssues({
    workspaceId,
    userId: "user",
    sessionId: crypto.randomUUID(),
    projects: [],
    records: [],
    cycles: [],
  })
}
beforeEach(() => {
  identity()
  snapshot = {
    workspaceId: "workspace",
    userId: "user",
    sessionId: "session",
    revision: 1,
    settings: {
      ...initialTeamCycles(),
      enabled: true,
      timezone: "Europe/Paris",
    },
    canManage: true,
    cycles: [
      {
        id: "cycle",
        teamId: "team",
        number: 7,
        startDate: "2026-11-02",
        endDate: "2026-11-15",
        timezone: "Europe/Paris",
        state: "Upcoming",
        issueCount: 1,
        completedCount: 0,
      },
    ],
  }
  mocks.load
    .mockReset()
    .mockImplementation(async () => structuredClone(snapshot))
  mocks.save.mockReset().mockResolvedValue({ value: { revision: 2 } })
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null)
})
describe("shared cycle requests", () => {
  it("deduplicates mounted views and uses durable windows", async () => {
    const first = renderHook(() => useSharedTeamCycles("team", true))
    const second = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() =>
      expect(first.result.current.snapshot?.cycles[0].number).toBe(7)
    )
    expect(second.result.current.snapshot?.cycles[0].startDate).toBe(
      "2026-11-02"
    )
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })
  it("fences a background response started before a successful settings save", async () => {
    const { result } = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() => expect(result.current.snapshot).toBeTruthy())
    const old = structuredClone(snapshot)
    let resolve!: (value: SharedCycleSnapshot) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    let loading: Promise<void> | undefined
    act(() => {
      loading = result.current.refresh()
    })
    mocks.save.mockImplementationOnce(async () => {
      snapshot = {
        ...snapshot,
        revision: 2,
        settings: { ...snapshot.settings, duration: 4 },
      }
      return { value: { revision: 2 } }
    })
    await act(async () => {
      expect(await result.current.update({ duration: 4 })).toBe(true)
    })
    await act(async () => {
      resolve(old)
      await loading
    })
    expect(result.current.snapshot?.revision).toBe(2)
    expect(result.current.snapshot?.settings.duration).toBe(4)
  })
  it("keeps an exact command after an uncertain response", async () => {
    const { result } = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() => expect(result.current.snapshot).toBeTruthy())
    mocks.save.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      expect(await result.current.update({ duration: 3 })).toBe(false)
    })
    const original = mocks.save.mock.calls[0][0]
    await act(async () => {
      await result.current.retry()
    })
    expect(mocks.save.mock.calls[1][0]).toEqual(original)
  })
  it("shows stale settings and rebases only after explicit retry", async () => {
    const { result } = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() => expect(result.current.snapshot).toBeTruthy())
    mocks.save.mockImplementationOnce(async () => {
      snapshot = {
        ...snapshot,
        revision: 2,
        settings: { ...snapshot.settings, cooldown: 0 },
      }
      throw new Error("This data changed in another session.")
    })
    await act(async () => {
      await result.current.update({ duration: 3 })
    })
    expect(result.current.error).toContain("Review the latest values")
    expect(result.current.snapshot?.settings.duration).toBe(2)
    expect(mocks.save).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.retry()
    })
    const next = mocks.save.mock.calls[1][0].data
    expect(next.expectedRevision).toBe(2)
    expect(JSON.parse(next.value)).toMatchObject({ duration: 3, cooldown: 0 })
    expect(next.commandKey).not.toBe(
      mocks.save.mock.calls[0][0].data.commandKey
    )
  })
  it("discards an old workspace response and denies member settings edits", async () => {
    let resolve!: (value: SharedCycleSnapshot) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const { result } = renderHook(() => useSharedTeamCycles("team", true))
    const stale = structuredClone(snapshot)
    await act(async () => {
      identity("other")
      snapshot = { ...snapshot, workspaceId: "other", canManage: false }
      resolve(stale)
    })
    await waitFor(() =>
      expect(result.current.snapshot?.workspaceId).toBe("other")
    )
    await act(async () => {
      expect(await result.current.update({ enabled: false })).toBe(false)
    })
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
