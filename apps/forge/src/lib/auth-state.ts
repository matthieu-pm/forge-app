import { notFound, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { protectedSessionEpoch } from "@/lib/protected-session"
import { createTimedRequestCache } from "@/lib/timed-request-cache"
import { getTeamRouteState } from "@/lib/team-state"
import { DEFAULT_HOME_ENTRY, authReturnPath } from "@/lib/default-home"
import { desktopAuthorizationQuery } from "@/lib/auth-session"

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
let cachedAuthEpoch = protectedSessionEpoch()

export function invalidateNavigationAuthState() {
  getCachedClientAuthState.clear()
  cachedAuthEpoch = protectedSessionEpoch()
}

export function getNavigationAuthState() {
  if (typeof window === "undefined") return getAuthState()
  if (cachedAuthEpoch !== protectedSessionEpoch())
    invalidateNavigationAuthState()
  return getCachedClientAuthState()
}

function redirectTarget(pathname: string, search = "", hash = "") {
  return `${pathname}${search}${hash}`
}

export async function publicRouteBeforeLoad({
  location,
}: {
  location?: { searchStr?: string }
} = {}) {
  const authState = await getNavigationAuthState()

  if (!authState.session) {
    return
  }

  // The browser must finish the desktop authorization handshake even when signed in.
  if (desktopAuthorizationQuery(location?.searchStr ?? "")) return
  const returnTo = authReturnPath(
    new URLSearchParams(location?.searchStr).get("redirect")
  )

  throw redirect({
    href: authState.workspace
      ? (returnTo ?? DEFAULT_HOME_ENTRY)
      : "/onboarding/workspace",
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
      to: DEFAULT_HOME_ENTRY,
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
