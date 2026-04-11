import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/insights")({
  beforeLoad: protectedRouteBeforeLoad,
  component: TeamInsightsPage,
})

function TeamInsightsPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/insights`)

  return <PagePlaceholder {...pageMeta} />
}
