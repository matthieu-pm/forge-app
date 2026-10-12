import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamProjectUpdatesSettings } from "@/components/team-project-updates-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/ai/updates")({
  component: TeamProjectUpdatesPage,
})

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")

function TeamProjectUpdatesPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamProjectUpdatesSettings key={team.id} team={team} />
}
