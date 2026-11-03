import { createFileRoute } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadFeatureAvailability } from "@/lib/feature-state"
import { FeatureUnavailable } from "@/components/feature-availability"

export const Route = createFileRoute("/reviews_/created")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => loadFeatureAvailability(),
  staleTime: 0,
  component: Page,
})

function Page() {
  const { features } = Route.useLoaderData()
  return <FeatureUnavailable feature="reviews" mode={features.reviews} />
}
