import { describe, expect, it, vi } from "vitest"

import { routeTree } from "@/routeTree.gen"
import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"
import { getTeamFromRouteMatches } from "@/lib/team-route-match"

vi.mock("@/lib/auth", () => ({ auth: {} }))

vi.mock("@/lib/auth-state", () => ({
  authenticatedRouteBeforeLoad: vi.fn(),
  getAuthState: vi.fn(),
  onboardingRouteBeforeLoad: vi.fn(),
  protectedRouteBeforeLoad: vi.fn(),
  protectedTeamRouteBeforeLoad: vi.fn(),
  publicRouteBeforeLoad: vi.fn(),
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
  it("loads team access once through the parent route", () => {
    const rootChildren = routeTree.children as unknown as Array<TestRoute>
    const teamRoute = rootChildren.find(
      (route) => route.options.id === "/teams/$teamSlug"
    )

    expect(teamRoute?.options.beforeLoad).toBeUndefined()
    expect(teamRoute?.options.loader).toBe(protectedTeamRouteBeforeLoad)
    expect(teamRoute?.options.staleTime).toBe(30_000)
    expect(teamRoute?.children).toHaveLength(6)
    expect(
      teamRoute?.children?.every(
        (route) => route.options.beforeLoad === undefined
      )
    ).toBe(true)
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
    expect(
      getTeamFromRouteMatches([{ context: { team: contextTeam } }])
    ).toBe(contextTeam)
  })
})
