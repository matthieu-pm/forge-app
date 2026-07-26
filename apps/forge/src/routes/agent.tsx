import { createFileRoute, redirect } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/agent")({
  beforeLoad: async (context) => {
    await protectedRouteBeforeLoad(context)
    throw redirect({ to: "/forge" })
  },
  component: () => null,
})
