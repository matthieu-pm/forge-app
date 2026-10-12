import { createFileRoute, getRouteApi, notFound } from "@tanstack/react-router"
import { UpcomingCycle } from "@/components/upcoming-cycle"

export const Route = createFileRoute("/teams/$teamSlug/cycle/$cycleNumber")({
  beforeLoad: ({ params }) => {
    if (!/^[1-6]$/.test(params.cycleNumber)) throw notFound()
  },
  component: CyclePage,
})

function CyclePage() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const { cycleNumber } = Route.useParams()
  return (
    <UpcomingCycle
      key={`${team.id}:${cycleNumber}`}
      team={team}
      cycleNumber={Number(cycleNumber)}
    />
  )
}
