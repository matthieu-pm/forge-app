import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

export const Route = createFileRoute("/teams/$teamSlug/views")({
  component: TeamViewsPage,
})

function TeamViewsPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/views`)

  return <PagePlaceholder {...pageMeta} />
}
