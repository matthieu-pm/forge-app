// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadDefaultHome } from "./default-home-state"

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  read: vi.fn(),
  header: vi.fn(),
}))
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (fn: unknown) => fn }),
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://forge.test/?agent_ui=true&userId=forged"),
  setResponseHeader: mocks.header,
}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.actor,
}))
vi.mock("@/application/preferences/preferences.server", () => ({
  readAccountPreferences: mocks.read,
}))
const handler = loadDefaultHome as unknown as () => Promise<string>
const actor = {
  userId: "u",
  workspaceId: "w",
  authentication: { kind: "session", sessionId: "s" },
}
beforeEach(() => {
  vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
  vi.stubEnv("FORGE_FEATURE_AGENT_UI", "true")
  mocks.actor.mockResolvedValue(actor)
  mocks.read.mockResolvedValue({ values: {} })
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe("FOR-131 authenticated default route", () => {
  it.each([
    ["agent", "/forge"],
    ["inbox", "/inbox"],
    ["my-issues", "/my-issues"],
  ])("AT-01 uses the server account preference %s", async (choice, path) => {
    mocks.read.mockResolvedValue({
      values: { "general.defaultHomeView": choice },
    })
    await expect(handler()).resolves.toBe(path)
    expect(mocks.read).toHaveBeenCalledWith(actor)
    expect(mocks.header).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store"
    )
  })
  it("AT-02 reads flags and preferences afresh for each open", async () => {
    mocks.read.mockResolvedValue({
      values: { "general.defaultHomeView": "agent" },
    })
    await expect(handler()).resolves.toBe("/forge")
    vi.stubEnv("FORGE_FEATURE_AGENT_UI", "false")
    await expect(handler()).resolves.toBe("/inbox")
    mocks.read.mockResolvedValue({
      values: { "general.defaultHomeView": "my-issues" },
    })
    await expect(handler()).resolves.toBe("/my-issues")
    expect(mocks.actor).toHaveBeenCalledTimes(3)
  })
  it.each(["false", "true"])(
    "fails closed before preference reads when membership is revoked (sync %s)",
    async (enabled) => {
      vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", enabled)
      mocks.actor.mockRejectedValue(new Error("Membership required"))
      await expect(handler()).rejects.toThrow("Membership required")
      expect(mocks.read).not.toHaveBeenCalled()
    }
  )
  it("uses the gated historical fallback when preference sync is disabled", async () => {
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "false")
    vi.stubEnv("FORGE_FEATURE_AGENT_UI", "false")
    await expect(handler()).resolves.toBe("/inbox")
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it("does not silently replace a preference when its read fails", async () => {
    mocks.read.mockRejectedValue(new Error("Offline"))
    await expect(handler()).rejects.toThrow("Offline")
  })
})
