import { createFileRoute } from "@tanstack/react-router"
import { CodeReviewsSettings } from "@/components/code-reviews-settings"

export const Route = createFileRoute("/settings/code-and-reviews")({
  component: CodeReviewsPage,
})
function CodeReviewsPage() {
  const { authState } = Route.useRouteContext()
  return (
    <CodeReviewsSettings key={authState.user!.id} userId={authState.user!.id} />
  )
}
