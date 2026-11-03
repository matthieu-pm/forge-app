import { afterEach, describe, expect, it, vi } from "vitest"
import { migrateBrowserData } from "./browser-data-migration"

const mocks = vi.hoisted(() => ({ save: vi.fn(), existing: vi.fn() }))
vi.mock("./protected-session", () => ({ protectedSessionEpoch: () => 1 }))
vi.mock("./product-storage", () => ({
  productStorage: { getItem: mocks.existing },
  productStorageIdentity: () => ({
    workspaceId: "w1",
    userId: "u1",
    teamIds: [],
  }),
  saveProductValue: mocks.save,
  preservePendingAndReload: vi.fn(),
  productStorageFailureIsDefinitive: () => false,
}))
afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
})
describe("FOR-103 legacy preservation", () => {
  it("leaves deferred browser bytes intact while migrating an ordinary view preference", async () => {
    const keys = [
      "forge:signals:v1:u1:w1",
      'forge:signal-documents:v1:["w1","u1"]',
      'forge:reviews-preview:v1:["w1","u1"]',
      "forge:workspace:w1:sla-settings",
      "forge:agent-personalization:v1:u1",
      "forge:team-agent-skills:v1",
      "forge:team-thread-summaries:v1:t",
    ]
    for (const storage of [localStorage, sessionStorage])
      for (const key of keys) storage.setItem(key, "original bytes")
    localStorage.setItem("forge:my-issues:v1:u1", "ordinary view")
    mocks.existing.mockReturnValue(null)
    mocks.save.mockResolvedValue(undefined)
    expect(await migrateBrowserData()).toEqual([])
    for (const storage of [localStorage, sessionStorage])
      for (const key of keys)
        expect(storage.getItem(key)).toBe("original bytes")
    expect(localStorage.getItem("forge:my-issues:v1:u1")).toBeNull()
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
      "forge:my-issues:v1:u1",
      "ordinary view"
    )
  })
})
