import { createFileRoute, redirect } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadDefaultHome } from "@/lib/default-home-state"

export const Route = createFileRoute("/")({
  beforeLoad: async (context) => {
    await protectedRouteBeforeLoad(context)
    throw redirect({ to: await loadDefaultHome(), replace: true })
  },
})
