// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadFeatureAvailability } from "@/lib/feature-state"
import { saveAccountPreferences } from "@/lib/account-preference-state"
import {
  deleteRecurringIssue,
  loadRecurringIssues,
  saveRecurringIssue,
} from "@/lib/recurring-issue-state"
import { loadTeamThreadSummariesAccess } from "@/lib/team-thread-summaries-state"

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  patch: vi.fn(),
  recurring: vi.fn(),
  summaries: vi.fn(),
}))
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      validator: (_schema: unknown) => builder,
      handler: (fn: unknown) => fn,
    }
    return builder
  },
  createServerOnlyFn: (fn: unknown) => fn,
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://forge.test/?workspaceId=allowed&enabled=true"),
  setResponseHeader: vi.fn(),
}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.actor,
}))
vi.mock("@/application/preferences/preferences.server", () => ({
  patchAccountPreferences: mocks.patch,
}))
vi.mock("@/application/recurring-issues/recurring-issues.server", () => ({
  loadRecurringIssues: mocks.recurring,
  saveRecurringIssue: mocks.recurring,
  deleteRecurringIssue: mocks.recurring,
}))
vi.mock("@/lib/team-thread-summaries-server", () => ({
  getTeamThreadSummariesAccess: mocks.summaries,
}))

// Invoke the real handler bodies with framework/auth adapters replaced by fixtures.
const handler = (fn: unknown) =>
  fn as (args?: { data: unknown }) => Promise<unknown>
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
describe("FOR-103 server function boundaries", () => {
  it("returns only availability for the authenticated workspace, regardless of query flags", async () => {
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({
        signals: { mode: "preview", workspaceIds: ["allowed"] },
      })
    )
    mocks.actor.mockResolvedValue({
      workspaceId: "other",
      userId: "u",
      authentication: { kind: "session", sessionId: "s" },
    })
    const result = (await handler(loadFeatureAvailability)()) as {
      workspaceId: string
      features: { signals: string }
    }
    expect(result.workspaceId).toBe("other")
    expect(result.features.signals).toBe("disabled")
    mocks.actor.mockRejectedValue(new Error("Unauthenticated"))
    await expect(handler(loadFeatureAvailability)()).rejects.toThrow(
      "Unauthenticated"
    )
  })
  it("denies personal guidance, recurring issue operations and summary discovery before their services run", async () => {
    mocks.actor.mockResolvedValue({
      workspaceId: "w1",
      userId: "u",
      authentication: { kind: "session", sessionId: "s" },
    })
    await expect(
      handler(saveAccountPreferences)({
        data: { patch: { "agent.guidance": "forged" } },
      })
    ).rejects.toThrow(/unavailable/)
    for (const fn of [
      loadRecurringIssues,
      saveRecurringIssue,
      deleteRecurringIssue,
      loadTeamThreadSummariesAccess,
    ])
      await expect(handler(fn)({ data: { slug: "eng" } })).rejects.toThrow(
        /unavailable/
      )
    expect(mocks.patch).not.toHaveBeenCalled()
    expect(mocks.recurring).not.toHaveBeenCalled()
    expect(mocks.summaries).not.toHaveBeenCalled()
  })
})
