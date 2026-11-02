import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCustomViews } from "./custom-views-state"
import {
  CANONICAL_ISSUES_CHANGED,
  clearCanonicalIssueQueryRecords,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import { invalidatePreferenceSession } from "./preference-session-events"
import { newCustomView } from "./custom-views"

const transport = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock("./saved-view-functions", () => ({
  loadSavedViews: transport.load,
  persistSavedView: transport.save,
}))
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "session",
}
const view = { ...newCustomView("issues", "alice"), revision: 1, canEdit: true }
const directory = () => ({
  ...identity,
  enabled: true,
  views: [view],
  error: "",
})
beforeEach(() => {
  invalidatePreferenceSession("start")
  replaceCanonicalIssues({ ...identity, records: [], projects: [], cycles: [] })
  transport.load.mockReset().mockResolvedValue(JSON.stringify(directory()))
  transport.save
    .mockReset()
    .mockResolvedValue({ value: { id: view.id, revision: 2 } })
})
afterEach(() => {
  cleanup()
  invalidatePreferenceSession("start")
  replaceCanonicalIssues(null)
})
describe("FOR-60 authenticated view client", () => {
  it("shares authenticated definitions across mounts and waits for server acknowledgment", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.views).toHaveLength(1))
    const changed = { ...view, name: "Changed" }
    let resolve!: (value: unknown) => void
    transport.save.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    let pending!: Promise<boolean>
    act(() => {
      pending = hook.result.current.save(changed)
    })
    expect(hook.result.current.views[0].name).toBe(view.name)
    transport.load.mockResolvedValue(
      JSON.stringify({ ...directory(), views: [{ ...changed, revision: 2 }] })
    )
    await act(async () => {
      resolve({})
      expect(await pending).toBe(true)
    })
    expect(hook.result.current.views[0].name).toBe("Changed")
    const second = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    expect(second.result.current.views).toEqual(hook.result.current.views)
  })
  it("retries failed commands with the same command identity", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.enabled).toBe(true))
    transport.save.mockRejectedValueOnce(new Error("Network failed"))
    await act(async () => {
      expect(await hook.result.current.favorite(view.id, true)).toBe(false)
    })
    await act(async () => {
      expect(await hook.result.current.favorite(view.id, true)).toBe(true)
    })
    expect(transport.save.mock.calls[0][0].data.commandKey).toBe(
      transport.save.mock.calls[1][0].data.commandKey
    )
    expect(transport.save.mock.calls[0][0].data.mutation).toEqual({
      action: "favorite",
      id: view.id,
      favorite: true,
    })
  })
  it("evicts failed refreshes and ignores responses from a retired session", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.views).toHaveLength(1))
    transport.load.mockRejectedValueOnce(new Error("Forbidden"))
    await act(async () => {
      await hook.result.current.refresh()
    })
    expect(hook.result.current.views).toEqual([])
    let resolve!: (value: string) => void
    transport.load.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    let pending: unknown
    act(() => {
      pending = hook.result.current.refresh()
    })
    await act(async () => {
      invalidatePreferenceSession("start")
      replaceCanonicalIssues(null)
      resolve(JSON.stringify(directory()))
      await pending
    })
    expect(hook.result.current.views).toEqual([])
  })
  it.each(["canonical refresh", "query invalidation"])(
    "hides saved definitions and favorites until %s is reauthorized",
    async (change) => {
      const hook = renderHook(() =>
        useCustomViews(identity.workspaceId, identity.userId)
      )
      await waitFor(() => expect(hook.result.current.views).toHaveLength(1))
      let resolve!: (value: string) => void
      transport.load.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          })
      )
      act(() => {
        if (change === "canonical refresh")
          replaceCanonicalIssues({
            ...identity,
            records: [],
            projects: [],
            cycles: [],
          })
        else {
          clearCanonicalIssueQueryRecords()
          window.dispatchEvent(new Event("forge:issue-queries-invalidated"))
        }
      })
      expect(hook.result.current.views).toEqual([])
      await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(2))
      await act(async () => {
        resolve(JSON.stringify({ ...directory(), views: [] }))
        await Promise.resolve()
      })
      expect(hook.result.current.views).toEqual([])
      await act(async () => {
        window.dispatchEvent(new Event(CANONICAL_ISSUES_CHANGED))
        await Promise.resolve()
      })
      expect(transport.load).toHaveBeenCalledTimes(2)
    }
  )
  it("does not restore definitions from a pre-revocation read after the new read completes", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.enabled).toBe(true))
    let resolve!: (value: string) => void
    transport.load
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          })
      )
      .mockResolvedValueOnce(JSON.stringify({ ...directory(), views: [] }))
    let old: unknown
    act(() => {
      old = hook.result.current.refresh()
    })
    act(() =>
      replaceCanonicalIssues({
        ...identity,
        records: [],
        projects: [],
        cycles: [],
      })
    )
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => {
      resolve(JSON.stringify(directory()))
      await old
    })
    expect(hook.result.current.views).toEqual([])
  })
  it("keeps an in-flight acknowledged write successful across an access refresh", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.enabled).toBe(true))
    let resolve!: (value: unknown) => void
    transport.save.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    let pending!: Promise<boolean>
    act(() => {
      pending = hook.result.current.save(view)
    })
    act(() =>
      replaceCanonicalIssues({
        ...identity,
        records: [],
        projects: [],
        cycles: [],
      })
    )
    expect(hook.result.current.views).toEqual([])
    expect(transport.load).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve({})
      expect(await pending).toBe(true)
    })
    expect(hook.result.current.views).toHaveLength(1)
    expect(transport.load).toHaveBeenCalledTimes(2)
  })
  it("an acknowledged write remains successful when its follow-up read fails", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.enabled).toBe(true))
    transport.load.mockRejectedValueOnce(new Error("Read unavailable"))
    await act(async () => {
      expect(await hook.result.current.save(view)).toBe(true)
    })
    expect(hook.result.current.views).toEqual([])
  })
  it("a refresh started before a save cannot overwrite its acknowledged result", async () => {
    const hook = renderHook(() =>
      useCustomViews(identity.workspaceId, identity.userId)
    )
    await waitFor(() => expect(hook.result.current.enabled).toBe(true))
    let resolve!: (value: string) => void
    transport.load.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    let stale: unknown
    act(() => {
      stale = hook.result.current.refresh()
    })
    const updated = { ...view, name: "Latest", revision: 2 }
    transport.load.mockResolvedValue(
      JSON.stringify({ ...directory(), views: [updated] })
    )
    await act(async () => {
      expect(await hook.result.current.save(updated)).toBe(true)
    })
    await act(async () => {
      resolve(JSON.stringify(directory()))
      await stale
    })
    expect(hook.result.current.views[0].name).toBe("Latest")
  })
})
