import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamTriageSettings } from "@/components/team-triage-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/triage")({
  component: TeamTriagePage,
})
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function TeamTriagePage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamTriageSettings key={team.id} team={team} />
}
