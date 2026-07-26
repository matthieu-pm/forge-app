import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router"

import type { TeamLifecycle } from "@/lib/team-contract"
import { TeamsSettings } from "@/components/teams-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadTeamDirectory } from "@/lib/team-state"

export const Route = createFileRoute("/settings_/teams")({
  beforeLoad: protectedRouteBeforeLoad,
  loaderDeps: ({ search }) => {
    const status = (search as Record<string, unknown>).status
    const lifecycle: TeamLifecycle =
      status === "archived" ? "archived" : "active"
    return { status: lifecycle }
  },
  loader: ({ deps }) => loadTeamDirectory({ data: deps.status }),
  component: TeamsSettingsRoute,
})

function TeamsSettingsRoute() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const directory = Route.useLoaderData()
  const search: Record<string, unknown> = Route.useSearch()
  const status: TeamLifecycle =
    search.status === "archived" ? "archived" : "active"
  const navigate = Route.useNavigate()

  function handleStatusChange(nextStatus: TeamLifecycle) {
    void navigate({
      search: (current) => ({ ...current, status: nextStatus }),
    })
  }

  return pathname === "/settings/teams" ? (
    <TeamsSettings
      directory={directory}
      status={status}
      onStatusChange={handleStatusChange}
    />
  ) : (
    <Outlet />
  )
}
