import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamAgentsSettings } from "@/components/team-agents-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/agents")({
  component: TeamAgentsPage,
})

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")

function TeamAgentsPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamAgentsSettings team={team} />
}
