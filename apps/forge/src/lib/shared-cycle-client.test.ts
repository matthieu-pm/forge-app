import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sharedCyclesEnabled, useSharedTeamCycles } from "./shared-cycle-client"
import {
  canonicalIssueState,
  cycleDisplayName,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
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
    sessionId: canonicalIssueState()!.sessionId,
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
      snapshot = {
        ...snapshot,
        workspaceId: "other",
        sessionId: canonicalIssueState()!.sessionId,
        canManage: false,
      }
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
  it("retries an exact retained command when both the save and reload were offline", async () => {
    const { result } = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() => expect(result.current.snapshot).toBeTruthy())
    mocks.save.mockRejectedValueOnce(new Error("offline"))
    mocks.load.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      await result.current.update({ duration: 3 })
    })
    expect(result.current.snapshot).toBeUndefined()
    const original = structuredClone(mocks.save.mock.calls[0][0])
    await act(async () => {
      await result.current.retry()
    })
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.save.mock.calls[1][0]).toEqual(original)
  })
  it("refreshes team settings held by an unmounted numbered view", async () => {
    const numbered = renderHook(() => useSharedTeamCycles("team", true, 7))
    await waitFor(() => expect(numbered.result.current.snapshot).toBeTruthy())
    numbered.unmount()
    snapshot = {
      ...snapshot,
      revision: 2,
      settings: { ...snapshot.settings, enabled: false },
    }
    const settings = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() =>
      expect(settings.result.current.snapshot?.revision).toBe(2)
    )
    expect(sharedCyclesEnabled("team")).toBe(false)
    const reopened = renderHook(() => useSharedTeamCycles("team", true, 7))
    expect(reopened.result.current.snapshot?.revision).toBe(2)
  })
  it("fences another numbered view's response when propagating confirmed settings", async () => {
    const numbered = renderHook(() => useSharedTeamCycles("team", true, 7))
    const settings = renderHook(() => useSharedTeamCycles("team", true))
    await waitFor(() => expect(numbered.result.current.snapshot).toBeTruthy())
    await waitFor(() => expect(settings.result.current.snapshot).toBeTruthy())
    const stale = structuredClone(snapshot)
    let resolve!: (value: SharedCycleSnapshot) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    let loading: Promise<void> | undefined
    act(() => {
      loading = numbered.result.current.refresh()
    })
    mocks.save.mockImplementationOnce(async () => {
      snapshot = {
        ...snapshot,
        revision: 2,
        settings: { ...snapshot.settings, futureCycles: 3 },
        cycles: [
          ...snapshot.cycles,
          { ...snapshot.cycles[0], id: "new-cycle", number: 8 },
        ],
      }
      return { value: { revision: 2 } }
    })
    await act(async () => {
      await settings.result.current.update({ futureCycles: 3 })
    })
    await act(async () => {
      resolve(stale)
      await loading
    })
    expect(numbered.result.current.snapshot?.revision).toBe(2)
    expect(
      numbered.result.current.snapshot?.cycles.some((c) => c.id === "new-cycle")
    ).toBe(true)
  })
  it("resolves retained date-based history within its issue's team", () => {
    const current = canonicalIssueState()!
    const common = { startDate: "2026-11-02", endDate: "2026-11-15" }
    replaceCanonicalIssues({
      ...current,
      cycles: [
        { ...common, id: "a", teamId: "team-a", number: 7 },
        { ...common, id: "b", teamId: "team-b", number: 2 },
      ],
    })
    expect(cycleDisplayName("2026-11-02", "team-b")).toBe("Cycle 2")
  })
})
