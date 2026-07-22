import { Outlet, createFileRoute } from "@tanstack/react-router"

import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings_/teams/$teamSlug")({
  beforeLoad: protectedTeamRouteBeforeLoad,
  component: TeamSettingsLayout,
})

function TeamSettingsLayout() {
  return <Outlet />
}
