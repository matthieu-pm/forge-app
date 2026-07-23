import { Outlet, createFileRoute } from "@tanstack/react-router"

import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug")({
  loader: protectedTeamRouteBeforeLoad,
  staleTime: 30_000,
  component: TeamLayout,
})

function TeamLayout() {
  return <Outlet />
}
