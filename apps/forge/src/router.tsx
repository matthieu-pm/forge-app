import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { registerProtectedRouteReset } from "./lib/protected-session"
import { onPreferenceSessionInvalidated } from "./lib/preference-session-events"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,

    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 30_000,
    defaultStaleTime: 30_000,
  })

  if (typeof window !== "undefined") {
    onPreferenceSessionInvalidated(() => {
      for (const match of router.state.matches) match.abortController.abort()
      router.clearCache()
    })
    registerProtectedRouteReset(async () => {
      router.clearCache()
      await router.invalidate({ sync: true })
    })
  }
  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
