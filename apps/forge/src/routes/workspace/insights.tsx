import { createFileRoute, redirect } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/workspace/insights")({
  beforeLoad: async (context) => {
    await protectedRouteBeforeLoad(context)
    throw redirect({ to: "/reviews", replace: true })
  },
})
