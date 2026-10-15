import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamMembersSettings } from "@/components/team-members-settings"
import { loadTeamMembers } from "@/lib/team-member-state"

export const Route = createFileRoute("/teams/$teamSlug/members")({
  validateSearch: (search: Record<string, unknown>): { invite?: boolean } => ({
    invite: search.invite === true || search.invite === "true",
  }),
  loader: ({ params }) => loadTeamMembers({ data: { slug: params.teamSlug } }),
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  return (
    <TeamMembersSettings
      key={team.id}
      team={team}
      directory={Route.useLoaderData()}
      home
      initialAddOpen={Route.useSearch().invite}
    />
  )
}
