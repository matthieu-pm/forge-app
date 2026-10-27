import { createFileRoute } from "@tanstack/react-router"
import { ReviewsPage } from "@/components/reviews/reviews-page"
import { validateReviewSearch } from "@/lib/review-detail"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/reviews")({
  validateSearch: validateReviewSearch,
  beforeLoad: protectedRouteBeforeLoad,
  component: Page,
})
function Page() {
  const { authState } = Route.useRouteContext()
  const selection = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ReviewsPage
      authState={authState}
      view="for-you"
      selection={selection}
      onNavigate={(search) => {
        void navigate({ search })
      }}
    />
  )
}
