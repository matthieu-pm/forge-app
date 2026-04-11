import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/signals")({
  beforeLoad: protectedRouteBeforeLoad,
  component: TeamSignalsPage,
})

function TeamSignalsPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/signals`)

  return <PagePlaceholder {...pageMeta} />
}
