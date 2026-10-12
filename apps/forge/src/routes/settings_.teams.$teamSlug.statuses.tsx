import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamIssueStatusesSettings } from "@/components/team-issue-statuses-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/statuses")({
  component: TeamIssueStatusesPage,
})
const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
function TeamIssueStatusesPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamIssueStatusesSettings key={team.id} team={team} />
}
