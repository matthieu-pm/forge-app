import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamHomeLayout, TeamOverview } from "@/components/team-home"
import { loadTeamMembers } from "@/lib/team-member-state"
import { useTeamHome } from "@/lib/team-home-state"

export const Route = createFileRoute("/teams/$teamSlug/overview")({
  loader: ({ params }) => loadTeamMembers({ data: { slug: params.teamSlug } }),
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const store = useTeamHome(team.id)
  return (
    <TeamHomeLayout team={team} tab="overview" store={store}>
      <TeamOverview
        key={team.id}
        team={team}
        store={store}
        directory={Route.useLoaderData()}
      />
    </TeamHomeLayout>
  )
}
