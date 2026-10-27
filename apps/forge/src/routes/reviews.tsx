import { createFileRoute } from "@tanstack/react-router"
import { ReviewsPage } from "@/components/reviews/reviews-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/reviews")({
  beforeLoad: protectedRouteBeforeLoad,
  component: Page,
})
function Page() {
  const { authState } = Route.useRouteContext()
  return <ReviewsPage authState={authState} view="for-you" />
}
