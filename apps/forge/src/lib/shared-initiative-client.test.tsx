import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useInitiatives } from "./initiatives-state"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import {
  blankInitiative,
  emptyInitiatives,
  initiativesSettingsStorageKey,
  initiativesStorageKey,
} from "./initiatives"
import { sharedInitiativeChanges } from "./shared-initiative-contract"
import {
  initiativeCommandPrefix,
  sharedInitiativesKey,
} from "./shared-initiative-key"
import {
  flushProductStorage,
  initializeProductStorage,
  initiativeDrafts,
  preservePendingAndReload,
  productStorage,
  refreshProductStorage,
  resetProductStorage,
  storageStatus,
} from "./product-storage"
import { loadProductState, persistProductState } from "./product-state-server"
import type { InitiativeStore } from "./initiatives"

vi.mock("./product-state-server", () => ({
  persistProductState: vi.fn(),
  loadProductState: vi.fn(),
}))
vi.mock("@/components/account-preference-provider", () => ({
  useWorkspaceView: () => ({ value: {}, error: "", save: () => true }),
}))
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "session",
}
const id = "00000000-0000-4000-8000-000000000001",
  projectId = "00000000-0000-4000-8000-000000000002"
const item = {
  ...blankInitiative("alice"),
  id,
  name: "Shared",
  number: 1,
  revision: 2,
}
const state = (): InitiativeStore => ({
  ...emptyInitiatives(),
  initiatives: [item],
  nextNumber: 2,
})
const snapshot = (value = state(), requestSequence = 1) => ({
  ...identity,
  requestSequence,
  entries: [
    {
      key: sharedInitiativesKey(identity.workspaceId),
      value: JSON.stringify(value),
      revision: 0,
    },
    {
      key: initiativesSettingsStorageKey(identity.workspaceId),
      value: JSON.stringify({ enabled: true, schedule: "none" }),
      revision: 0,
    },
  ],
})
beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(persistProductState)
    .mockReset()
    .mockRejectedValue(new Error("Offline"))
  vi.mocked(loadProductState).mockReset().mockResolvedValue(snapshot())
  initializeProductStorage(snapshot(), false)
  replaceCanonicalIssues({
    ...identity,
    records: [],
    cycles: [],
    projects: [
      {
        id: projectId,
        name: "Authorized",
        revision: 1,
        legacyId: null,
        properties: {},
      },
    ],
  })
})
afterEach(() => {
  cleanup()
  resetProductStorage()
  replaceCanonicalIssues(null, false)
})
it("uses canonical initiatives instead of publishing a private legacy snapshot", () => {
  productStorage.setItem(
    initiativesStorageKey(identity.workspaceId),
    JSON.stringify({
      ...state(),
      initiatives: [{ ...item, name: "Private legacy" }],
    })
  )
  const hook = renderHook(() =>
    useInitiatives(identity.workspaceId, identity.userId)
  )
  expect(hook.result.current.state.initiatives[0].name).toBe("Shared")
})
it("queues exact revision and explicit link deltas, preserves failed drafts and replays unchanged bytes", async () => {
  const hook = renderHook(() =>
    useInitiatives(identity.workspaceId, identity.userId)
  )
  act(() =>
    expect(
      hook.result.current.update((s) => ({
        ...s,
        initiatives: s.initiatives.map((i) => ({ ...i, summary: "Draft" })),
      }))
    ).toBe(true)
  )
  await waitFor(() => expect(storageStatus().error).toBe("Offline"))
  const first = vi.mocked(persistProductState).mock.calls[0][0]
  expect(first.data.key).toContain(initiativeCommandPrefix)
  expect(JSON.parse(first.data.value!)[0]).toMatchObject({
    expectedRevision: 2,
    changes: { summary: "Draft" },
    addProjectIds: [],
    removeProjectIds: [],
  })
  expect(initiativeDrafts()).toHaveLength(1)
  await act(() => flushProductStorage())
  expect(vi.mocked(persistProductState).mock.calls[1][0]).toEqual(first)
})
it("rejects stale forms and retained callbacks after session switch", () => {
  const hook = renderHook(() =>
    useInitiatives(identity.workspaceId, identity.userId)
  )
  const opened = hook.result.current.state.initiatives[0],
    callback = hook.result.current.update
  act(() =>
    refreshProductStorage(
      snapshot(
        { ...state(), initiatives: [{ ...item, revision: 3, name: "Newer" }] },
        2
      )
    )
  )
  act(() =>
    expect(
      hook.result.current.update((s) => ({
        ...s,
        initiatives: [{ ...opened, summary: "Stale" }],
      }))
    ).toBe(false)
  )
  expect(hook.result.current.mutationError).toContain("changed while editing")
  act(() =>
    initializeProductStorage({ ...snapshot(), sessionId: "new-session" }, false)
  )
  act(() =>
    expect(
      callback((s) => ({ ...s, initiatives: [{ ...item, summary: "Late" }] }))
    ).toBe(false)
  )
  expect(persistProductState).not.toHaveBeenCalled()
})
it("does not restore older privacy/progress snapshots even at the same resource revision", () => {
  refreshProductStorage(
    snapshot({ ...state(), initiatives: [{ ...item, projects: [] }] }, 3)
  )
  refreshProductStorage(
    snapshot({ ...state(), initiatives: [{ ...item, name: "Stale read" }] }, 2)
  )
  expect(
    JSON.parse(
      productStorage.getItem(sharedInitiativesKey(identity.workspaceId))!
    ).initiatives[0].name
  ).toBe("Shared")
})
it("recovers a private immutable draft and hides it when linked project access is revoked", async () => {
  const key = `${initiativeCommandPrefix}${crypto.randomUUID()}`,
    value = JSON.stringify([
      {
        id,
        expectedRevision: 2,
        changes: { summary: "Retained" },
        addProjectIds: [projectId],
        removeProjectIds: [],
      },
    ])
  productStorage.setItem(key, value)
  await waitFor(() => expect(storageStatus().error).toBe("Offline"))
  vi.mocked(persistProductState).mockImplementation(async ({ data }) => ({
    replayed: false,
    value: { revision: data.expectedRevision + 1 },
  }))
  vi.mocked(loadProductState).mockImplementation(async () => ({
    ...snapshot(),
    entries: [
      ...snapshot().entries,
      ...vi
        .mocked(persistProductState)
        .mock.calls.filter(([{ data }]) =>
          data.key.startsWith("forge:pending-recovery:")
        )
        .map(([{ data }]) => ({
          key: data.key,
          value: data.value,
          revision: 1,
        })),
    ],
  }))
  expect(await preservePendingAndReload()).toBe(true)
  expect(initiativeDrafts()).toMatchObject([{ recovery: true, value }])
  replaceCanonicalIssues({ ...identity, records: [], cycles: [], projects: [] })
  expect(initiativeDrafts()).toEqual([])
})
it("only diffs visible membership and rejects unsupported lifecycle or resources", () => {
  const p = {
    id: projectId,
    name: "Authorized",
    status: "Planned" as const,
    health: "On track" as const,
    teamIds: [],
  }
  const changes = sharedInitiativeChanges(state(), {
    ...state(),
    initiatives: [{ ...item, projects: [p] }],
  })
  expect(changes[0]).toMatchObject({
    changes: {},
    addProjectIds: [projectId],
    removeProjectIds: [],
  })
  expect(() => sharedInitiativeChanges(state(), emptyInitiatives())).toThrow(
    /deletion/
  )
  expect(() =>
    sharedInitiativeChanges(state(), {
      ...state(),
      initiatives: [{ ...item, views: [{ id: "view", name: "View" }] }],
    })
  ).toThrow(/saved views/)
})

it("keeps a newer initiative child authorization snapshot instead of replacing it from the project cache", () => {
  const child = {
    id: projectId,
    name: "Fresh project",
    revision: 1,
    status: "Completed" as const,
    health: "Update missing" as const,
    teamIds: [],
  }
  initializeProductStorage(
    snapshot({ ...state(), initiatives: [{ ...item, projects: [child] }] }),
    false
  )
  replaceCanonicalIssues({
    ...identity,
    records: [],
    cycles: [],
    projects: [
      {
        id: projectId,
        name: "Older project",
        legacyId: null,
        revision: 1,
        properties: { teamIds: ["revoked-private-team"], status: "Active" },
      },
    ],
  })
  const hook = renderHook(() =>
    useInitiatives(identity.workspaceId, identity.userId)
  )
  expect(hook.result.current.state.initiatives[0].projects[0]).toMatchObject({
    name: "Fresh project",
    status: "Completed",
    teamIds: [],
  })
  expect(JSON.stringify(hook.result.current.state.initiatives)).not.toContain(
    "revoked-private-team"
  )
})
