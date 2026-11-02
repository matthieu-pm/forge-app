import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useViewProjectQuery } from "./saved-view-project-client"
import {
  CANONICAL_ISSUES_CHANGED,
  clearCanonicalIssueQueryRecords,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import { invalidatePreferenceSession } from "./preference-session-events"
import { defaultProjectPreferences } from "./project-view-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"

const transport = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock("./saved-view-functions", () => ({
  loadViewProjectQuery: transport.load,
}))
const identity = {
  workspaceId: "workspace",
  userId: "bob",
  sessionId: "session",
}
const project = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Private project",
  revision: 1,
  status: "Planned",
  health: "On track",
  teamIds: [],
}
const snapshot = (visible = true): CanonicalSnapshot => ({
  ...identity,
  records: [],
  cycles: [],
  projects: visible
    ? [
        {
          id: project.id,
          name: project.name,
          revision: 1,
          legacyId: null,
          properties: project,
        },
      ]
    : [],
})
const display = defaultProjectPreferences()
function useQuery() {
  return useViewProjectQuery(
    true,
    identity.workspaceId,
    identity.userId,
    [],
    display
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  invalidatePreferenceSession("start")
  replaceCanonicalIssues(snapshot())
  transport.load.mockReset().mockResolvedValue(
    JSON.stringify({
      projects: [project],
      authorizedProjectIds: [project.id],
    })
  )
})
afterEach(() => {
  cleanup()
  invalidatePreferenceSession("start")
  replaceCanonicalIssues(null)
})
describe("FOR-60 saved project query access freshness", () => {
  it.each(["canonical refresh", "query invalidation"])(
    "evicts a previously displayed project immediately on %s",
    async (change) => {
      const hook = renderHook(useQuery)
      await waitFor(() =>
        expect(hook.result.current.projects).toEqual([project])
      )
      const fresh = deferred<string>()
      transport.load.mockReturnValueOnce(fresh.promise)
      act(() => {
        if (change === "canonical refresh")
          replaceCanonicalIssues(snapshot(false))
        else {
          clearCanonicalIssueQueryRecords()
          window.dispatchEvent(new Event("forge:issue-queries-invalidated"))
        }
      })
      expect(hook.result.current.projects).toEqual([])
      expect(hook.result.current.loading).toBe(true)
      await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(2))
      await act(async () => {
        fresh.resolve(
          JSON.stringify({ projects: [], authorizedProjectIds: [] })
        )
        await fresh.promise
      })
      expect(hook.result.current.projects).toEqual([])
      expect(hook.result.current.loading).toBe(false)
    }
  )
  it("cannot restore a revoked project from a request begun before the access refresh", async () => {
    const old = deferred<string>()
    transport.load
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        JSON.stringify({ projects: [], authorizedProjectIds: [] })
      )
    const hook = renderHook(useQuery)
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(1))
    act(() => replaceCanonicalIssues(snapshot(false)))
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => {
      old.resolve(
        JSON.stringify({
          projects: [project],
          authorizedProjectIds: [project.id],
        })
      )
      await old.promise
    })
    expect(hook.result.current.projects).toEqual([])
  })
  it("keeps unfiltered authorization separate from filtered project rows", async () => {
    transport.load.mockResolvedValueOnce(
      JSON.stringify({ projects: [], authorizedProjectIds: [project.id] })
    )
    const hook = renderHook(useQuery)
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    expect(hook.result.current.projects).toEqual([])
    expect(hook.result.current.authorizedProjectIds).toEqual([project.id])
  })
  it("does not refetch for ordinary issue notifications or its own completed query", async () => {
    const hook = renderHook(useQuery)
    await waitFor(() => expect(hook.result.current.projects).toEqual([project]))
    await act(async () => {
      window.dispatchEvent(new Event(CANONICAL_ISSUES_CHANGED))
      await Promise.resolve()
    })
    expect(transport.load).toHaveBeenCalledTimes(1)
  })
})
