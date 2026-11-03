import { createFileRoute } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { FeatureUnavailable } from "@/components/feature-availability"

export const Route = createFileRoute("/settings/code-and-reviews")({
  beforeLoad: protectedRouteBeforeLoad,
  component: Page,
})

function Page() {
  return <FeatureUnavailable feature="reviews" />
}
