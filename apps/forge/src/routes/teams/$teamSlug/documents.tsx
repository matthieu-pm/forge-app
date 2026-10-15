import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamDocuments } from "@/components/team-home-documents"

export const Route = createFileRoute("/teams/$teamSlug/documents")({
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  return <TeamDocuments key={team.id} team={team} />
}
