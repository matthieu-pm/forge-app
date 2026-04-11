import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/calls")({
  beforeLoad: protectedRouteBeforeLoad,
  component: TeamCallsPage,
})

function TeamCallsPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/calls`)

  return <PagePlaceholder {...pageMeta} />
}
