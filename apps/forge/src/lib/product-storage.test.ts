import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  flushProductStorage,
  initializeProductStorage,
  preservePendingAndReload,
  productStorage,
  productStorageRefreshToken,
  refreshProductStorage,
  resetProductStorage,
  saveProductValue,
  storageStatus,
} from "./product-storage"
import { loadProductState, persistProductState } from "./product-state-server"
import { migrateBrowserData } from "./browser-data-migration"
import { productStateCommandSchema } from "./product-state-contract"

vi.mock("./product-state-server", () => ({
  persistProductState: vi.fn(),
  loadProductState: vi.fn(),
}))
const identity = {
  workspaceId: "workspace",
  sessionId: "session",
  userId: "user",
  entries: [],
}
beforeEach(() => {
  resetProductStorage()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.mocked(persistProductState)
    .mockReset()
    .mockImplementation(async ({ data }) => {
      productStateCommandSchema.parse(data)
      return { replayed: false, value: { revision: data.expectedRevision + 1 } }
    })
  vi.mocked(loadProductState).mockResolvedValue(identity)
  initializeProductStorage(identity)
})
afterEach(() => {
  resetProductStorage()
  vi.restoreAllMocks()
})
describe("server product persistence and one-way browser migration", () => {
  it("evicts issue relationship drafts after team revocation even during an older refresh", () => {
    const teamId = "00000000-0000-4000-8000-000000000001"
    const issueId = "00000000-0000-4000-8000-000000000002"
    const key = `forge:team-relationship-draft:v1:${teamId}:${issueId}`
    initializeProductStorage({
      ...identity,
      teamIds: [teamId],
      entries: [{ key, value: "private retained command", revision: 1 }],
    })
    refreshProductStorage({ ...identity, teamIds: [], entries: [] }, -1)
    expect(productStorage.getItem(key)).toBeNull()
  })

  it("saves through an identity-bound command without native storage writes", async () => {
    const native = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Forbidden")
      })
    await saveProductValue("forge:desktop-tabs", "tabs")
    expect(native).not.toHaveBeenCalled()
    expect(persistProductState).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace",
        sessionId: "session",
        key: "forge:desktop-tabs",
        expectedRevision: 0,
      }),
    })
    expect(storageStatus()).toEqual({ pending: 0, error: "" })
  })
  it("retains failed saves in memory and retries the exact command", async () => {
    vi.mocked(persistProductState).mockRejectedValueOnce(new Error("Offline"))
    productStorage.setItem("forge:desktop-tabs", "pending")
    await vi.waitFor(() => expect(storageStatus().error).toBe("Offline"))
    expect(productStorage.getItem("forge:desktop-tabs")).toBe("pending")
    const first = vi.mocked(persistProductState).mock.calls[0][0]
    await flushProductStorage()
    expect(vi.mocked(persistProductState).mock.calls[1][0]).toEqual(first)
    expect(storageStatus().pending).toBe(0)
  })
  it("removes native sources only after durable acknowledgement", async () => {
    window.localStorage.setItem("forge:desktop-tabs", "old tabs")
    let resolve!: (value: {
      replayed: boolean
      value: { revision: number }
    }) => void
    vi.mocked(persistProductState).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const migration = migrateBrowserData()
    await vi.waitFor(() => expect(persistProductState).toHaveBeenCalled())
    expect(window.localStorage.getItem("forge:desktop-tabs")).toBe("old tabs")
    resolve({ replayed: false, value: { revision: 1 } })
    expect(await migration).toEqual([])
    expect(window.localStorage.getItem("forge:desktop-tabs")).toBeNull()
  })
  it("keeps native sources if the server copy fails", async () => {
    window.localStorage.setItem("forge:desktop-tabs", "old tabs")
    vi.mocked(persistProductState).mockRejectedValue(new Error("Offline"))
    expect(await migrateBrowserData()).toHaveLength(1)
    expect(window.localStorage.getItem("forge:desktop-tabs")).toBe("old tabs")
  })
  it("archives conflicting legacy bytes on the server without overwriting current data", async () => {
    initializeProductStorage({
      ...identity,
      entries: [
        { key: "forge:desktop-tabs", value: "server tabs", revision: 3 },
      ],
    })
    window.localStorage.setItem("forge:desktop-tabs", "old tabs")
    expect(await migrateBrowserData()).toEqual([])
    expect(productStorage.getItem("forge:desktop-tabs")).toBe("server tabs")
    const saved = vi.mocked(persistProductState).mock.calls[0][0].data
    expect(saved.key).toMatch(/^forge:legacy-conflict:/)
    expect(JSON.parse(saved.value!).value).toBe("old tabs")
    expect(window.localStorage.getItem("forge:desktop-tabs")).toBeNull()
  })
  it("protects pending edits from refresh and excludes late saves after a session switch", async () => {
    let resolve!: (value: {
      replayed: boolean
      value: { revision: number }
    }) => void
    vi.mocked(persistProductState).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    productStorage.setItem("forge:desktop-tabs", "pending")
    refreshProductStorage({
      ...identity,
      entries: [{ key: "forge:desktop-tabs", value: "older", revision: 1 }],
    })
    expect(productStorage.getItem("forge:desktop-tabs")).toBe("pending")
    initializeProductStorage({
      ...identity,
      userId: "other",
      sessionId: "other-session",
      entries: [],
    })
    resolve({ replayed: false, value: { revision: 1 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(productStorage.getItem("forge:desktop-tabs")).toBeNull()
    expect(storageStatus().pending).toBe(0)
  })
  it("preserves pending conflicts on the server before loading the latest version", async () => {
    vi.mocked(persistProductState).mockRejectedValueOnce(
      new Error("Stale revision")
    )
    productStorage.setItem("forge:desktop-tabs", "my pending version")
    await vi.waitFor(() => expect(storageStatus().error).toBe("Stale revision"))
    vi.mocked(loadProductState).mockImplementation(async () => ({
      ...identity,
      entries: [
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
        {
          key: "forge:desktop-tabs",
          value: "latest server version",
          revision: 3,
        },
      ],
    }))
    await preservePendingAndReload()
    const recovery = vi.mocked(persistProductState).mock.calls[1][0].data
    expect(recovery.key).toMatch(/^forge:pending-recovery:/)
    expect(JSON.parse(recovery.value!).value).toBe("my pending version")
    expect(productStorage.getItem("forge:desktop-tabs")).toBe(
      "latest server version"
    )
    expect(storageStatus()).toEqual({ pending: 0, error: "" })
  })
  it("does not regress acknowledged writes when an older refresh completes", async () => {
    const token = productStorageRefreshToken()
    await saveProductValue("forge:desktop-tabs", "new")
    refreshProductStorage({ ...identity, entries: [] }, token)
    expect(productStorage.getItem("forge:desktop-tabs")).toBe("new")
    refreshProductStorage({
      ...identity,
      entries: [{ key: "forge:desktop-tabs", value: "old", revision: 0 }],
    })
    expect(productStorage.getItem("forge:desktop-tabs")).toBe("new")
    refreshProductStorage({ ...identity, entries: [] })
    expect(productStorage.getItem("forge:desktop-tabs")).toBeNull()
  })
  it("removes a revoked team's cached source on an authorized refresh", () => {
    const teamId = "60109b0b-7cd4-4097-9883-196a80ff2493",
      key = `forge:team-issues:v1:${teamId}`
    initializeProductStorage({
      ...identity,
      teamIds: [teamId],
      entries: [{ key, value: "private", revision: 1 }],
    })
    refreshProductStorage({ ...identity, teamIds: [], entries: [] })
    expect(productStorage.getItem(key)).toBeNull()
  })
  it("excludes another account, workspace and unknown keys before reading native payloads", async () => {
    window.localStorage.setItem("forge:profile:other", "SECRET")
    window.localStorage.setItem(
      "forge:workspace:other:initiatives:v1",
      "SECRET"
    )
    window.localStorage.setItem("forge:unknown-token", "SECRET")
    const reads = vi.spyOn(Storage.prototype, "getItem")
    expect(await migrateBrowserData()).toEqual([])
    expect(
      reads.mock.calls.some(([key]) =>
        [
          "forge:profile:other",
          "forge:workspace:other:initiatives:v1",
          "forge:unknown-token",
        ].includes(key)
      )
    ).toBe(false)
  })
})
