import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamTriage } from "@/components/team-triage"

export const Route = createFileRoute("/teams/$teamSlug/triage")({
  component: TriagePage,
})
function TriagePage() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  return <TeamTriage key={team.id} team={team} />
}
