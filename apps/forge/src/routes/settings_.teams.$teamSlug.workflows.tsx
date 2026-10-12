import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamWorkflowsSettings } from "@/components/team-workflows-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/workflows")({
  component: TeamWorkflowsPage,
})
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function TeamWorkflowsPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamWorkflowsSettings key={team.id} team={team} />
}
