import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamAgentSkillsSettings } from "@/components/team-agent-skills-settings"

export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/agent-skills/"
)({ component: Page })
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
const teamsRoute = getRouteApi("/settings_/teams")
function Page() {
  const { team } = teamRoute.useLoaderData()
  const { items } = teamsRoute.useLoaderData()
  return <TeamAgentSkillsSettings key={team.id} team={team} teams={items} />
}
