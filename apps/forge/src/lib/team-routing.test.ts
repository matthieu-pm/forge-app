import { describe, expect, it, vi } from "vitest"

import { routeTree } from "@/routeTree.gen"
import {
  protectedRouteBeforeLoad,
  protectedTeamRouteBeforeLoad,
} from "@/lib/auth-state"
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
