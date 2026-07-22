import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/views")({
  beforeLoad: protectedTeamRouteBeforeLoad,
  component: TeamViewsPage,
})

function TeamViewsPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/views`)

  return <PagePlaceholder {...pageMeta} />
}
