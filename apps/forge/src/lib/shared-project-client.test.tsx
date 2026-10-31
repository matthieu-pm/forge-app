import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useInitiatives } from "./initiatives-state"
import {
  canonicalProjects,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import { emptyInitiatives, initiativesStorageKey } from "./initiatives"
import {
  flushProductStorage,
  initializeProductStorage,
  pendingProjectDrafts,
  preservePendingAndReload,
  resetProductStorage,
  savedProjectDrafts,
  storageStatus,
} from "./product-storage"
import { loadProductState, persistProductState } from "./product-state-server"
import { refreshCanonicalIssues } from "./canonical-issue-client"
import { sharedProjectChanges } from "./shared-project-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"
import type { InitiativeProject } from "./initiatives"

vi.mock("./product-state-server", () => ({
  persistProductState: vi.fn(),
  loadProductState: vi.fn(),
}))
vi.mock("./canonical-issue-client", () => ({ refreshCanonicalIssues: vi.fn() }))
vi.mock("@/components/account-preference-provider", () => ({
  useWorkspaceView: () => ({ value: {}, error: "", save: () => true }),
}))
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "session",
}
const id = "00000000-0000-4000-8000-000000000001"
const shared: InitiativeProject = {
  id,
  revision: 2,
  name: "Shared",
  status: "Planned",
  teamIds: [],
  health: "Update missing",
}
const snapshot = (project = shared): CanonicalSnapshot => ({
  ...identity,
  records: [],
  cycles: [],
  projects: [
    {
      id: project.id,
      revision: project.revision,
      name: project.name,
      legacyId: null,
      properties: project,
    },
  ],
})
beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(persistProductState)
    .mockReset()
    .mockRejectedValue(new Error("Offline"))
  vi.mocked(refreshCanonicalIssues)
    .mockReset()
    .mockImplementation(async () => {
      const next = snapshot({ ...shared, revision: 3, name: "Saved" })
      replaceCanonicalIssues(next)
      return next
    })
  initializeProductStorage({ ...identity, entries: [] }, false)
  replaceCanonicalIssues(snapshot())
})
afterEach(() => {
  cleanup()
  resetProductStorage()
  replaceCanonicalIssues(null, false)
})
describe("FOR-54 shared project client", () => {
  it("rejects a stale full form after background refresh instead of silently rebasing it", () => {
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    const opened = hook.result.current.state.workspaceProjects[0]
    act(() =>
      replaceCanonicalIssues(
        snapshot({ ...shared, revision: 3, summary: "Bob's newer summary" })
      )
    )
    act(() =>
      expect(
        hook.result.current.update((state) => ({
          ...state,
          workspaceProjects: [{ ...opened, status: "Active" }],
        }))
      ).toBe(false)
    )
    expect(hook.result.current.mutationError).toContain(
      "changed while you were editing"
    )
    expect(persistProductState).not.toHaveBeenCalled()
    expect(canonicalProjects(identity.workspaceId)[0].summary).toBe(
      "Bob's newer summary"
    )
  })
  it("hides immutable pending and saved batches after project revocation without deleting their originals", async () => {
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    act(() => {
      hook.result.current.update((state) => ({
        ...state,
        workspaceProjects: [{ ...shared, summary: "Private retained work" }],
      }))
    })
    await waitFor(() => expect(storageStatus().error).toBe("Offline"))
    const command = vi.mocked(persistProductState).mock.calls[0][0].data
    expect(pendingProjectDrafts()).toHaveLength(1)
    act(() => replaceCanonicalIssues({ ...snapshot(), projects: [] }))
    expect(pendingProjectDrafts()).toEqual([])
    expect(storageStatus().pending).toBe(1)
    act(() =>
      initializeProductStorage(
        {
          ...identity,
          entries: [
            {
              key: "forge:pending-recovery:v1:copy",
              value: JSON.stringify({ key: command.key, value: command.value }),
              revision: 1,
            },
          ],
        },
        false
      )
    )
    expect(savedProjectDrafts()).toEqual([])
    act(() => replaceCanonicalIssues(snapshot()))
    expect(savedProjectDrafts()).toHaveLength(1)
    expect(JSON.stringify(savedProjectDrafts())).toContain(
      "Private retained work"
    )
  })
  it("rejects an old workspace callback before enqueueing a project command under a new identity", () => {
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    const update = hook.result.current.update
    act(() => {
      initializeProductStorage(
        { ...identity, workspaceId: "other-workspace", entries: [] },
        false
      )
      replaceCanonicalIssues({ ...snapshot(), workspaceId: "other-workspace" })
    })
    act(() =>
      expect(
        update((state) => ({
          ...state,
          workspaceProjects: [{ ...shared, name: "Late autosave" }],
        }))
      ).toBe(false)
    )
    expect(persistProductState).not.toHaveBeenCalled()
  })
  it("rejects a retired session callback even when the new session has the same user and workspace", () => {
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    const update = hook.result.current.update
    act(() => {
      initializeProductStorage(
        { ...identity, sessionId: "new-session", entries: [] },
        false
      )
      replaceCanonicalIssues({ ...snapshot(), sessionId: "new-session" })
    })
    act(() =>
      expect(
        update((state) => ({
          ...state,
          workspaceProjects: [{ ...shared, name: "Old-session autosave" }],
        }))
      ).toBe(false)
    )
    expect(persistProductState).not.toHaveBeenCalled()
  })
  it("keeps canonical projects available when a private legacy source is malformed", () => {
    initializeProductStorage(
      {
        ...identity,
        entries: [
          {
            key: initiativesStorageKey(identity.workspaceId),
            value: "invalid legacy bytes",
            revision: 1,
          },
        ],
      },
      false
    )
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    expect(hook.result.current.error).toBe("")
    expect(hook.result.current.state.workspaceProjects[0].name).toBe("Shared")
  })
  it("removes stale personal projects when the canonical directory is empty or access is revoked", () => {
    initializeProductStorage(
      {
        ...identity,
        entries: [
          {
            key: initiativesStorageKey(identity.workspaceId),
            value: JSON.stringify({
              ...emptyInitiatives(),
              workspaceProjects: [{ ...shared, name: "Stale private project" }],
            }),
            revision: 1,
          },
        ],
      },
      false
    )
    replaceCanonicalIssues(null, false)
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    expect(hook.result.current.state.workspaceProjects[0].name).toBe(
      "Stale private project"
    )
    act(() => replaceCanonicalIssues({ ...snapshot(), projects: [] }))
    expect(hook.result.current.state.workspaceProjects).toEqual([])
    act(() => replaceCanonicalIssues(snapshot()))
    expect(hook.result.current.state.workspaceProjects[0].name).toBe("Shared")
    act(() => replaceCanonicalIssues({ ...snapshot(), projects: [] }))
    expect(hook.result.current.state.workspaceProjects).toEqual([])
  })
  it("journals the exact revision-bound draft, retains failures and retries the original command", async () => {
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    act(() => {
      expect(
        hook.result.current.update((state) => ({
          ...state,
          workspaceProjects: state.workspaceProjects.map((p) => ({
            ...p,
            name: "Saved",
          })),
        }))
      ).toBe(true)
    })
    await waitFor(() => expect(storageStatus().error).toBe("Offline"))
    expect(hook.result.current.state.workspaceProjects[0].name).toBe("Saved")
    const first = vi.mocked(persistProductState).mock.calls[0][0]
    expect(JSON.parse(first.data.value!)).toEqual([
      { id, expectedRevision: 2, changes: { name: "Saved" } },
    ])
    expect(canonicalProjects(identity.workspaceId)[0].name).toBe("Shared")
    vi.mocked(persistProductState).mockResolvedValue({
      replayed: false,
      value: { revision: 1 },
    })
    await act(async () => {
      await flushProductStorage()
    })
    expect(vi.mocked(persistProductState).mock.calls[1][0]).toEqual(first)
    expect(storageStatus().pending).toBe(0)
    expect(pendingProjectDrafts()).toEqual([])
    expect(hook.result.current.state.workspaceProjects[0]).toMatchObject({
      name: "Saved",
      revision: 3,
    })
  })
  it("preserves a conflicting draft privately before loading latest", async () => {
    const saved = new Map<string, string | null>()
    vi.mocked(persistProductState).mockImplementation(async ({ data }) => {
      if (data.key.startsWith("forge:project-command:"))
        throw new Error("This project changed in another session.")
      saved.set(data.key, data.value)
      return { replayed: false, value: { revision: 1 } }
    })
    vi.mocked(loadProductState).mockImplementation(async () => ({
      ...identity,
      entries: [...saved].map(([key, value]) => ({ key, value, revision: 1 })),
    }))
    const hook = renderHook(() =>
      useInitiatives(identity.workspaceId, identity.userId, "projects")
    )
    act(() => {
      hook.result.current.update((state) => ({
        ...state,
        workspaceProjects: [{ ...shared, name: "My conflicting draft" }],
      }))
    })
    await waitFor(() =>
      expect(storageStatus().error).toContain("changed in another session")
    )
    await act(async () => {
      expect(await preservePendingAndReload()).toBe(true)
    })
    expect(storageStatus().pending).toBe(0)
    expect([...saved.values()].join()).toContain("My conflicting draft")
    expect(hook.result.current.state.workspaceProjects[0].name).toBe("Saved")
  })
  it("does not overwrite newer acknowledged project versions with delayed metadata refreshes", () => {
    replaceCanonicalIssues(snapshot({ ...shared, revision: 5, name: "Newest" }))
    replaceCanonicalIssues(snapshot())
    expect(canonicalProjects(identity.workspaceId)[0].name).toBe("Newest")
  })
  it("keeps advanced metadata out of canonical commands and permits an empty default project form", () => {
    const before = { ...emptyInitiatives(), workspaceProjects: [shared] }
    expect(() =>
      sharedProjectChanges(before, {
        ...before,
        workspaceProjects: [
          {
            ...shared,
            milestones: [{ id: "m", name: "Milestone", completed: false }],
          },
        ],
      })
    ).toThrow("not available yet")
    expect(
      sharedProjectChanges(emptyInitiatives(), {
        ...emptyInitiatives(),
        workspaceProjects: [
          {
            ...shared,
            revision: undefined,
            milestones: [],
            labelIds: [],
            dependencyIds: [],
          },
        ],
      })[0].expectedRevision
    ).toBeNull()
  })
})
