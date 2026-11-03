import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { retireProtectedSession } from "@/lib/protected-session"

import {
  getNavigationAuthState,
  invalidateNavigationAuthState,
  protectedRouteBeforeLoad,
  protectedTeamRouteBeforeLoad,
  publicRouteBeforeLoad,
} from "@/lib/auth-state"

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

describe("auth route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateNavigationAuthState()
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

  it("reuses the login auth check when entering the protected workspace", async () => {
    await expect(publicRouteBeforeLoad()).rejects.toBeDefined()

    const result = await protectedRouteBeforeLoad({
      location: {
        pathname: "/inbox",
        searchStr: "",
        hash: "",
      },
    })

    expect(result).toEqual({
      authState: {
        session: {
          id: "session-1",
          activeOrganizationId: "workspace-1",
        },
        user: { id: "user-1" },
        workspace: { id: "workspace-1" },
      },
    })
    expect(mocks.getAuthState).toHaveBeenCalledOnce()
  })

  it("FOR-131 sends a signed-in default login to the common home entry", async () => {
    await expect(publicRouteBeforeLoad()).rejects.toMatchObject({
      options: { href: "/" },
    })
  })

  it("FOR-131 preserves explicit auth return URLs including search and hash", async () => {
    const path = "/teams/product/issues?issue=FOR-131#comment-1"
    await expect(
      publicRouteBeforeLoad({
        location: { searchStr: `?redirect=${encodeURIComponent(path)}` },
      })
    ).rejects.toMatchObject({ options: { href: path } })
  })

  it("FOR-131 lets a signed-in desktop authorization handshake complete", async () => {
    await expect(
      publicRouteBeforeLoad({
        location: {
          searchStr:
            "?client_id=electron&state=state&code_challenge=challenge&code_challenge_method=S256",
        },
      })
    ).resolves.toBeUndefined()
  })

  it("FOR-131 preserves an unauthenticated deep link for sign-in", async () => {
    mocks.getAuthState.mockResolvedValue({ session: null, workspace: null })
    await expect(
      protectedRouteBeforeLoad({
        location: {
          pathname: "/teams/product/issues",
          searchStr: "?issue=FOR-131",
          hash: "comment-1",
        },
      })
    ).rejects.toMatchObject({
      options: {
        to: "/login",
        search: { redirect: "/teams/product/issues?issue=FOR-131#comment-1" },
      },
    })
  })

  it("FOR-131 preserves an actual router-parsed issue fragment through authentication", async () => {
    mocks.getAuthState.mockResolvedValue({ session: null, workspace: null })
    const path = "/teams/product/issues?issue=FOR-131#comment-1"
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: [path] }),
    })
    expect(router.latestLocation.hash).toBe("comment-1")
    await expect(
      protectedRouteBeforeLoad({ location: router.latestLocation })
    ).rejects.toMatchObject({ options: { search: { redirect: path } } })
  })
  it("FOR-131 preserves a carried Login fragment for an already signed-in actor", async () => {
    await expect(
      publicRouteBeforeLoad({
        location: {
          searchStr: "?redirect=%2Fteams%2Fproduct%2Fissues%3Fissue%3DFOR-131",
          hash: "comment-1",
        },
      })
    ).rejects.toMatchObject({
      options: { href: "/teams/product/issues?issue=FOR-131#comment-1" },
    })
  })
  it("shares navigation state beyond five seconds and reloads after invalidation", async () => {
    vi.useFakeTimers()
    try {
      await getNavigationAuthState()
      vi.advanceTimersByTime(6_000)
      await getNavigationAuthState()
      expect(mocks.getAuthState).toHaveBeenCalledOnce()
      invalidateNavigationAuthState()
      await getNavigationAuthState()
      expect(mocks.getAuthState).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(30_001)
      await getNavigationAuthState()
      expect(mocks.getAuthState).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

it("FOR-52 never reuses navigation auth data from a retired tab/session generation", async () => {
  invalidateNavigationAuthState()
  mocks.getAuthState.mockResolvedValueOnce({ user: { id: "alice" } })
  await expect(getNavigationAuthState()).resolves.toEqual({
    user: { id: "alice" },
  })
  mocks.getAuthState.mockResolvedValueOnce({ user: { id: "bob" } })
  retireProtectedSession()
  await expect(getNavigationAuthState()).resolves.toEqual({
    user: { id: "bob" },
  })
})
