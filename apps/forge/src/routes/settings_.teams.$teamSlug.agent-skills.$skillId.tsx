import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamAgentSkillEditor } from "@/components/team-agent-skills-settings"

export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/agent-skills/$skillId"
)({ component: Page })
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function Page() {
  const { team } = teamRoute.useLoaderData()
  const { skillId } = Route.useParams()
  return (
    <TeamAgentSkillEditor
      key={`${team.id}:${skillId}`}
      team={team}
      skillId={skillId}
    />
  )
}
