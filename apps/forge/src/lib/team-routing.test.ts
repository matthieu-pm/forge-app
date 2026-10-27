import { describe, expect, it, vi } from "vitest"

import { routeTree } from "@/routeTree.gen"
import { Route as teamProjectsRoute } from "@/routes/teams/$teamSlug/projects"
import {
  getNavigationAuthState,
  protectedRouteBeforeLoad,
  protectedTeamRouteBeforeLoad,
} from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"
import { getTeamFromRouteMatches } from "@/lib/team-route-match"

vi.mock("@/lib/auth", () => ({ auth: {} }))

vi.mock("@/lib/auth-state", () => ({
  authenticatedRouteBeforeLoad: vi.fn(),
  getAuthState: vi.fn(),
  getNavigationAuthState: vi.fn(),
  onboardingRouteBeforeLoad: vi.fn(),
  protectedRouteBeforeLoad: vi.fn(),
  protectedTeamRouteBeforeLoad: vi.fn(),
  publicRouteBeforeLoad: vi.fn(),
}))

vi.mock("@/lib/initiative-directory", () => ({
  loadInitiativeDirectory: vi.fn(),
}))

type TestRoute = {
  options: {
    id?: string
    path?: string
    beforeLoad?: unknown
    loader?: unknown
    staleTime?: number
  }
  children?: Array<TestRoute>
}

describe("team app routes", () => {
  it("loads project user details and directory without a second access guard", async () => {
    const authState = {
      user: {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        image: null,
      },
      session: { id: "session-1", activeOrganizationId: "workspace-1" },
      workspace: {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        logo: null,
      },
    }
    const directory = { people: [], teams: [], error: "" }
    vi.mocked(getNavigationAuthState).mockResolvedValue(authState)
    vi.mocked(loadInitiativeDirectory).mockResolvedValue(directory)

    const loader = teamProjectsRoute.options.loader
    expect(typeof loader).toBe("function")
    if (typeof loader !== "function") throw new Error("Missing projects loader")

    await expect(loader({} as never)).resolves.toEqual({ authState, directory })
    expect(getNavigationAuthState).toHaveBeenCalledOnce()
    expect(loadInitiativeDirectory).toHaveBeenCalledOnce()
  })

  it("loads team access once through the parent route", () => {
    const rootChildren = routeTree.children as unknown as Array<TestRoute>
    const teamRoute = rootChildren.find(
      (route) => route.options.id === "/teams/$teamSlug"
    )

    expect(teamRoute?.options.beforeLoad).toBeUndefined()
    expect(teamRoute?.options.loader).toBe(protectedTeamRouteBeforeLoad)
    expect(teamRoute?.options.staleTime).toBe(30_000)
    const assertNoRepeatedAccessCheck = (route: TestRoute) => {
      // Child routes may validate parameters, but must reuse parent access.
      expect(route.options.beforeLoad).not.toBe(protectedTeamRouteBeforeLoad)
      expect(route.options.beforeLoad).not.toBe(protectedRouteBeforeLoad)
      expect(route.options.loader).not.toBe(protectedTeamRouteBeforeLoad)
      route.children?.forEach(assertNoRepeatedAccessCheck)
    }
    expect(teamRoute?.children?.length).toBeGreaterThan(0)
    teamRoute?.children?.forEach(assertNoRepeatedAccessCheck)
  })

  it("prefers loader team data while supporting existing route context", () => {
    const loaderTeam = { slug: "product" }
    const contextTeam = { slug: "engineering" }

    expect(
      getTeamFromRouteMatches([
        { context: { team: contextTeam } },
        { loaderData: { team: loaderTeam } },
      ])
    ).toBe(loaderTeam)
    expect(getTeamFromRouteMatches([{ context: { team: contextTeam } }])).toBe(
      contextTeam
    )
  })
})
