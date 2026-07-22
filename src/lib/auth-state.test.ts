import { beforeEach, describe, expect, it, vi } from "vitest"

import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

const mocks = vi.hoisted(() => ({
  getAuthState: vi.fn(),
  getTeam: vi.fn(),
  getTeamRouteState: vi.fn(),
}))

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: () => mocks.getAuthState,
  }),
}))

vi.mock("@/lib/team-state", () => ({
  getTeam: mocks.getTeam,
  getTeamRouteState: mocks.getTeamRouteState,
}))

describe("protectedTeamRouteBeforeLoad", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthState.mockResolvedValue({
      session: { id: "session-1", activeOrganizationId: "workspace-1" },
      user: { id: "user-1" },
      workspace: { id: "workspace-1" },
    })
    mocks.getTeam.mockResolvedValue({ slug: "product" })
    mocks.getTeamRouteState.mockResolvedValue({
      status: "ready",
      team: { slug: "product" },
    })
  })

  it("loads auth and team data through one server boundary", async () => {
    const result = await protectedTeamRouteBeforeLoad({
      location: {
        pathname: "/settings/teams/product",
        searchStr: "",
        hash: "",
      },
      params: { teamSlug: "product" },
    })

    expect(result).toEqual({ team: { slug: "product" } })
    expect(mocks.getTeamRouteState).toHaveBeenCalledOnce()
    expect(mocks.getAuthState).not.toHaveBeenCalled()
    expect(mocks.getTeam).not.toHaveBeenCalled()
  })
})
