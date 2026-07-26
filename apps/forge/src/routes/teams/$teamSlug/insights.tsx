import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

export const Route = createFileRoute("/teams/$teamSlug/insights")({
  component: TeamInsightsPage,
})

function TeamInsightsPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/insights`)

  return <PagePlaceholder {...pageMeta} />
}
