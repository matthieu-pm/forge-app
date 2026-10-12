import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamCyclesSettings } from "@/components/team-cycles-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/cycles")({
  component: TeamCyclesPage,
})
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function TeamCyclesPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamCyclesSettings key={team.id} team={team} />
}
