import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamLoops } from "@/components/team-home-loops"

export const Route = createFileRoute("/teams/$teamSlug/loops")({
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  return <TeamLoops key={team.id} team={team} />
}
