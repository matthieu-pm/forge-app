import { describe, expect, it, vi } from "vitest"

import { routeTree } from "@/routeTree.gen"
import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

vi.mock("@/lib/auth", () => ({ auth: {} }))

vi.mock("@/lib/auth-state", () => ({
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

describe("team settings routes", () => {
  it("keeps the team overview and general settings as sibling child routes", () => {
    const rootChildren = routeTree.children as unknown as Array<TestRoute>
    const teamSettingsRoute = rootChildren.find(
      (route) => route.options.id === "/settings_/teams/$teamSlug",
    )

    expect(
      teamSettingsRoute?.children?.map((route) => route.options.path),
    ).toEqual(expect.arrayContaining(["/", "/general"]))
  })

  it("loads team access through the cached loader path", () => {
    const rootChildren = routeTree.children as unknown as Array<TestRoute>
    const teamSettingsRoute = rootChildren.find(
      (route) => route.options.id === "/settings_/teams/$teamSlug",
    )

    expect(teamSettingsRoute?.options.beforeLoad).toBeUndefined()
    expect(teamSettingsRoute?.options.loader).toBe(
      protectedTeamRouteBeforeLoad,
    )
    expect(teamSettingsRoute?.options.staleTime).toBe(30_000)
  })
})
