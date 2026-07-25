import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"

import { TeamsSettings } from "@/components/teams-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { listTeams } from "@/lib/team-state"

export const Route = createFileRoute("/settings_/teams")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => listTeams(),
  component: TeamsSettingsRoute,
})

function TeamsSettingsRoute() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const teams = Route.useLoaderData()

  return pathname === "/settings/teams" ? (
    <TeamsSettings teams={teams} />
  ) : (
    <Outlet />
  )
}
