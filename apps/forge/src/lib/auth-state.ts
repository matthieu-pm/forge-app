import { notFound, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { createTimedRequestCache } from "@/lib/timed-request-cache"
import { getTeamRouteState } from "@/lib/team-state"

export const getAuthState = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { buildAuthState }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/auth-server"),
    ])

    return buildAuthState(getRequest())
  }
)

// This cache only drives navigation; every protected server request still
// checks the current session and membership independently.
const getCachedClientAuthState = createTimedRequestCache(getAuthState, 30_000)

export function invalidateNavigationAuthState() {
  getCachedClientAuthState.clear()
}

export function getNavigationAuthState() {
  return typeof window === "undefined"
    ? getAuthState()
    : getCachedClientAuthState()
}

function redirectTarget(pathname: string, search = "", hash = "") {
  return `${pathname}${search}${hash}`
}

export async function publicRouteBeforeLoad() {
  const authState = await getNavigationAuthState()

  if (!authState.session) {
    return
  }

  throw redirect({
    to: authState.workspace ? "/inbox" : "/onboarding/workspace",
  })
}

export async function onboardingRouteBeforeLoad({
  location,
}: {
  location: {
    pathname: string
    searchStr?: string
    hash?: string
  }
}) {
  const authState = await getAuthState()

  if (!authState.session) {
    throw redirect({
      to: "/login",
      search: {
        redirect: redirectTarget(
          location.pathname,
          location.searchStr,
          location.hash
        ),
      },
    })
  }

  if (authState.workspace) {
    throw redirect({
      to: "/inbox",
    })
  }
}

export async function protectedRouteBeforeLoad({
  location,
}: {
  location: {
    pathname: string
    searchStr?: string
    hash?: string
  }
}) {
  const authState = await getNavigationAuthState()

  if (!authState.session) {
    throw redirect({
      to: "/login",
      search: {
        redirect: redirectTarget(
          location.pathname,
          location.searchStr,
          location.hash
        ),
      },
    })
  }

  if (!authState.workspace) {
    throw redirect({
      to: "/onboarding/workspace",
    })
  }

  return { authState }
}

export async function authenticatedRouteBeforeLoad({
  location,
}: {
  location: {
    pathname: string
    searchStr?: string
    hash?: string
  }
}) {
  const authState = await getNavigationAuthState()

  if (!authState.session) {
    throw redirect({
      to: "/login",
      search: {
        redirect: redirectTarget(
          location.pathname,
          location.searchStr,
          location.hash
        ),
      },
    })
  }

  return { authState }
}

export async function protectedTeamRouteBeforeLoad({
  location,
  params,
}: {
  location: {
    pathname: string
    searchStr?: string
    hash?: string
  }
  params: { teamSlug: string }
}) {
  const state = await getTeamRouteState({ data: { slug: params.teamSlug } })

  if (state.status === "unauthenticated") {
    throw redirect({
      to: "/login",
      search: {
        redirect: redirectTarget(
          location.pathname,
          location.searchStr,
          location.hash
        ),
      },
    })
  }

  if (state.status === "no-workspace") {
    throw redirect({ to: "/onboarding/workspace" })
  }

  if (state.status !== "ready") {
    throw notFound()
  }

  return { team: state.team }
}
