import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamThreadSummariesSettings } from "@/components/team-thread-summaries-settings"
import { loadTeamThreadSummariesAccess } from "@/lib/team-thread-summaries-state"

export const Route = createFileRoute("/settings_/teams/$teamSlug/ai/summaries")(
  {
    loader: ({ params }) =>
      loadTeamThreadSummariesAccess({ data: { slug: params.teamSlug } }),
    component: TeamThreadSummariesPage,
  }
)
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function TeamThreadSummariesPage() {
  const { team } = teamRoute.useLoaderData()
  const access = Route.useLoaderData()
  return <TeamThreadSummariesSettings key={team.id} team={team} {...access} />
}
