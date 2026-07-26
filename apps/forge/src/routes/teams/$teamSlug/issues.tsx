import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

export const Route = createFileRoute("/teams/$teamSlug/issues")({
  component: TeamIssuesPage,
})

function TeamIssuesPage() {
  const { teamSlug } = Route.useParams()
  const pageMeta = getPageMeta(`/teams/${teamSlug}/issues`)

  return <PagePlaceholder {...pageMeta} />
}
