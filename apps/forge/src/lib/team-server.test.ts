import { beforeEach, describe, expect, it, vi } from "vitest"

import { listTeamsForRequest } from "@/lib/team-server"

const mocks = vi.hoisted(() => ({
  actor: {
    userId: "user-1",
    workspaceId: "workspace-1",
    workspaceRole: "member",
    authentication: { kind: "session" as const, sessionId: "session-1" },
    scopes: null,
  },
  listTeams: vi.fn(),
  requireSessionActor: vi.fn(),
}))

vi.mock("@/application/teams/teams.server", () => ({
  archiveTeam: vi.fn(),
  createTeam: vi.fn(),
  getTeam: vi.fn(),
  listTeams: mocks.listTeams,
  updateTeam: vi.fn(),
}))

vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.requireSessionActor,
}))

vi.mock("@/lib/auth-server", () => ({
  WorkspaceAccessError: class WorkspaceAccessError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))

describe("team request adapter", () => {
  beforeEach(() => {
    mocks.listTeams.mockReset()
    mocks.requireSessionActor.mockReset().mockResolvedValue(mocks.actor)
  })

  it("preserves the first-party all-teams behavior across pages", async () => {
    const firstTeam = { id: "team-1" }
    const secondTeam = { id: "team-2" }
    mocks.listTeams
      .mockResolvedValueOnce({ items: [firstTeam], nextCursor: "next-page" })
      .mockResolvedValueOnce({ items: [secondTeam], nextCursor: null })

    await expect(
      listTeamsForRequest(new Request("https://forge.test/settings"))
    ).resolves.toEqual([firstTeam, secondTeam])
    expect(mocks.requireSessionActor).toHaveBeenCalledTimes(1)
    expect(mocks.listTeams).toHaveBeenNthCalledWith(1, mocks.actor, {
      cursor: undefined,
    })
    expect(mocks.listTeams).toHaveBeenNthCalledWith(2, mocks.actor, {
      cursor: "next-page",
    })
  })
})
