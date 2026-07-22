import { Outlet, createFileRoute } from "@tanstack/react-router"

import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings_/teams/$teamSlug")({
  loader: protectedTeamRouteBeforeLoad,
  staleTime: 30_000,
  component: TeamSettingsLayout,
})

function TeamSettingsLayout() {
  return <Outlet />
}
