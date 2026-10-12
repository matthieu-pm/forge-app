import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { UpcomingCycle } from "@/components/upcoming-cycle"

export const Route = createFileRoute("/teams/$teamSlug/cycle/upcoming")({
  component: UpcomingCyclePage,
})

function UpcomingCyclePage() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  return <UpcomingCycle key={team.id} team={team} />
}
