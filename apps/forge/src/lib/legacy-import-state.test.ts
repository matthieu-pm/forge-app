import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadLegacyPreviewContext } from "./legacy-import-state"

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  auth: vi.fn(),
  teams: vi.fn(),
  definitions: vi.fn(),
  header: vi.fn(),
}))
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (handler: () => Promise<unknown>) => handler,
  }),
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://forge.example/settings/import-export"),
  setResponseHeader: mocks.header,
}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.actor,
}))
vi.mock("@/lib/auth-server", () => ({ buildAuthState: mocks.auth }))
vi.mock("@/lib/team-server", () => ({
  getTeamDirectoryForRequest: mocks.teams,
}))
vi.mock("@/application/issue-definitions/definitions.server", () => ({
  readAllIssueDefinitions: mocks.definitions,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor.mockResolvedValue({
    userId: "alice",
    workspaceId: "workspace",
    authentication: { kind: "session", sessionId: "session" },
    scopes: null,
  })
  mocks.auth.mockResolvedValue({
    user: { id: "alice" },
    session: { id: "session" },
    workspace: { id: "workspace", name: "Destination" },
  })
  mocks.teams.mockResolvedValue({
    items: [
      {
        id: "member-team",
        name: "Member team",
        visibility: "private",
        isMember: true,
      },
      {
        id: "visible-team",
        name: "Visible but not joined",
        visibility: "workspace",
        isMember: false,
      },
    ],
  })
  mocks.definitions.mockResolvedValue({
    userId: "alice",
    sessionId: "session",
    workspaceId: "workspace",
    snapshots: [],
  })
})

describe("read-only destination context", () => {
  it("requires a current session, avoids caching and limits destinations to live memberships", async () => {
    const result = await loadLegacyPreviewContext()
    expect(mocks.actor).toHaveBeenCalledOnce()
    expect(mocks.header).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store"
    )
    expect(mocks.teams).toHaveBeenCalledWith(expect.any(Request), "active")
    expect(result.teams).toEqual([
      { id: "member-team", name: "Member team", visibility: "private" },
    ])
    expect(result.actorId).toBe("alice")
  })
  it("fails closed when authentication or workspace membership is revoked", async () => {
    mocks.actor.mockRejectedValue(new Error("FORBIDDEN"))
    await expect(loadLegacyPreviewContext()).rejects.toThrow("FORBIDDEN")
    expect(mocks.teams).not.toHaveBeenCalled()
    expect(mocks.definitions).not.toHaveBeenCalled()
  })
  it.each([
    { userId: "bob", sessionId: "session", workspaceId: "workspace" },
    { userId: "alice", sessionId: "new-session", workspaceId: "workspace" },
    { userId: "alice", sessionId: "session", workspaceId: "other-workspace" },
  ])(
    "rejects inconsistent actor/session/workspace reads: %j",
    async (identity) => {
      mocks.definitions.mockResolvedValue({ ...identity, snapshots: [] })
      await expect(loadLegacyPreviewContext()).rejects.toThrow(
        "active account changed"
      )
    }
  )
})
