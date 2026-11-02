import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useTeamLoops } from "./loop-client"
import { loadTeamLoops, persistTeamLoop } from "./loop-state"
import type { LoopCommand, LoopSnapshot } from "./loop-contract"

const fixture = vi.hoisted(() => ({
  identity: { workspaceId: "workspace", userId: "alice", sessionId: "session" },
  epoch: 0,
  invalidate: null as null | (() => void),
}))
vi.mock("./loop-state", () => ({
  loadTeamLoops: vi.fn(),
  persistTeamLoop: vi.fn(),
}))
vi.mock("./product-storage", () => ({
  productStorageIdentity: () => fixture.identity,
}))
vi.mock("./protected-session", () => ({
  protectedSessionEpoch: () => fixture.epoch,
}))
vi.mock("./preference-session-events", () => ({
  onPreferenceSessionInvalidated: (callback: () => void) => {
    fixture.invalidate = callback
    return () => {
      fixture.invalidate = null
    }
  },
}))
const empty: LoopSnapshot = { loops: [], runs: [], enabled: true }
const input = (): LoopCommand => ({
  action: "create",
  id: crypto.randomUUID(),
  fields: {
    name: "Investigate",
    description: "",
    instructions: "Investigate the event",
    trigger: { kind: "event", entity: "issue", event: "created" },
    conditions: [],
    reasoning: "auto",
    teamAccess: "this-team",
  },
})
beforeEach(() => {
  localStorage.clear()
  fixture.identity = {
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session",
  }
  fixture.epoch = 0
  vi.mocked(loadTeamLoops).mockResolvedValue(JSON.stringify(empty))
})
afterEach(cleanup)
describe("Loop browser authority and recovery", () => {
  it("keeps the original immutable command/key across an uncertain failure and reload", async () => {
    const command = input()
    vi.mocked(persistTeamLoop).mockRejectedValueOnce(new Error("Response lost"))
    const first = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    await act(async () => {
      await expect(first.result.current.command(command)).rejects.toThrow(
        "Response lost"
      )
    })
    expect(first.result.current.pending).toHaveLength(1)
    const request = vi.mocked(persistTeamLoop).mock.calls[0][0]
    first.unmount()
    vi.mocked(persistTeamLoop).mockResolvedValueOnce(
      JSON.stringify({ status: "saved", id: command.id, revision: 1 })
    )
    const second = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(second.result.current.pending).toHaveLength(1))
    await act(async () => {
      await second.result.current.retry(second.result.current.pending[0])
    })
    expect(vi.mocked(persistTeamLoop).mock.calls[1][0]).toEqual(request)
    expect(second.result.current.pending).toHaveLength(0)
    expect(localStorage.length).toBe(0)
  })
  it("applies a post-command revision before returning despite a competing focus refresh", async () => {
    const result = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(result.result.current.ready).toBe(true))
    let finish: (value: string) => void = () => {}
    const current = {
      ...empty,
      choices: { status: [{ id: "new", name: "Latest status" }] },
    }
    vi.mocked(loadTeamLoops)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(JSON.stringify(current))
    vi.mocked(persistTeamLoop).mockResolvedValueOnce(
      JSON.stringify({ status: "saved", id: crypto.randomUUID(), revision: 2 })
    )
    let completed = false,
      pending: Promise<unknown>
    act(() => {
      pending = result.result.current.command(input()).then(() => {
        completed = true
      })
    })
    await waitFor(() => expect(loadTeamLoops).toHaveBeenCalledTimes(2))
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      finish(JSON.stringify(empty))
      await pending!
    })
    expect(completed).toBe(true)
    expect(result.result.current.snapshot).toEqual(current)
  })
  it("does not start a remote effect when recovery storage is unavailable", async () => {
    const result = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(result.result.current.ready).toBe(true))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable")
    })
    await act(async () => {
      await expect(result.result.current.command(input())).rejects.toThrow(
        "Storage unavailable"
      )
    })
    expect(persistTeamLoop).not.toHaveBeenCalled()
  })
  it("retires an explicitly rejected request without treating it as saved", async () => {
    vi.mocked(persistTeamLoop).mockResolvedValueOnce(
      JSON.stringify({
        status: "rejected",
        message: "No workspace model available",
      })
    )
    const result = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(result.result.current.ready).toBe(true))
    let outcome: unknown
    await act(async () => {
      outcome = await result.result.current.command(input())
    })
    expect(outcome).toEqual({
      status: "rejected",
      message: "No workspace model available",
    })
    expect(result.result.current.pending).toHaveLength(0)
    expect(localStorage.length).toBe(0)
  })
  it("clears protected content on failed authorization and invalidation", async () => {
    const result = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(result.result.current.snapshot).toEqual(empty))
    vi.mocked(loadTeamLoops).mockRejectedValueOnce(new Error("Access revoked"))
    await act(async () => {
      await result.result.current.refresh()
    })
    expect(result.result.current.snapshot).toBeNull()
    expect(result.result.current.error).toBe("Access revoked")
    act(() => {
      fixture.epoch++
      fixture.invalidate?.()
    })
    expect(result.result.current.ready).toBe(false)
  })
  it("ignores an old account response after session identity changes", async () => {
    let finish: (value: string) => void = () => {}
    vi.mocked(loadTeamLoops).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const result = renderHook(() => useTeamLoops("team"))
    await act(async () => {
      fixture.identity = {
        ...fixture.identity,
        userId: "bob",
        sessionId: "bob-session",
      }
      fixture.epoch++
      fixture.invalidate?.()
      finish(JSON.stringify(empty))
      await Promise.resolve()
    })
    expect(result.result.current.snapshot).toBeNull()
    expect(result.result.current.ready).toBe(false)
  })
  it("keeps another account’s unresolved request isolated", async () => {
    vi.mocked(persistTeamLoop).mockRejectedValueOnce(new Error("Network"))
    const first = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    await act(async () => {
      await expect(first.result.current.command(input())).rejects.toThrow(
        "Network"
      )
    })
    first.unmount()
    fixture.identity = {
      ...fixture.identity,
      userId: "bob",
      sessionId: "bob-session",
    }
    const second = renderHook(() => useTeamLoops("team"))
    await waitFor(() => expect(second.result.current.ready).toBe(true))
    expect(second.result.current.pending).toHaveLength(0)
    expect(localStorage.length).toBe(1)
  })
})
