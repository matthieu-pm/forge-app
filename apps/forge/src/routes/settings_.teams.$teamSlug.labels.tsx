import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamIssueLabelsSettings } from "@/components/team-issue-labels-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/labels")({
  component: TeamIssueLabelsPage,
})

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")

function TeamIssueLabelsPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamIssueLabelsSettings key={team.id} team={team} />
}
