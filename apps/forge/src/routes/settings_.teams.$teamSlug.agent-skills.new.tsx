import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamAgentSkillEditor } from "@/components/team-agent-skills-settings"

export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/agent-skills/new"
)({ component: Page })
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function Page() {
  const { team } = teamRoute.useLoaderData()
  return <TeamAgentSkillEditor key={team.id} team={team} />
}
