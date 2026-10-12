import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamCycles } from "@/components/team-cycles"

export const Route = createFileRoute("/teams/$teamSlug/cycles")({
  component: TeamCyclesPage,
})

function TeamCyclesPage() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  return <TeamCycles key={team.id} team={team} />
}
