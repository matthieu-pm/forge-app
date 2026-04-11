import { redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import type { AuthState } from "@/lib/auth-types"

export const getAuthState = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { buildAuthState }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/auth-server"),
    ])

    return buildAuthState(getRequest())
  }
)

function redirectTarget(pathname: string, search = "", hash = "") {
  return `${pathname}${search}${hash}`
}

export async function publicRouteBeforeLoad() {
  const authState = (await getAuthState()) as AuthState

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
  const authState = (await getAuthState()) as AuthState

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
  const authState = (await getAuthState()) as AuthState

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
}
