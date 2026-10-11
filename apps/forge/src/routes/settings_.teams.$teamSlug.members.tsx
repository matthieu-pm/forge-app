import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamMembersSettings } from "@/components/team-members-settings"
import { loadTeamMembers } from "@/lib/team-member-state"

export const Route = createFileRoute("/settings_/teams/$teamSlug/members")({
  loader: ({ params }) => loadTeamMembers({ data: { slug: params.teamSlug } }),
  component: TeamMembersPage,
})

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")

function TeamMembersPage() {
  const { team } = teamRoute.useLoaderData()
  return <TeamMembersSettings team={team} directory={Route.useLoaderData()} />
}
