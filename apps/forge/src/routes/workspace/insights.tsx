import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/insights")

export const Route = createFileRoute("/workspace/insights")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InsightsPage,
})

function InsightsPage() {
  return <PagePlaceholder {...pageMeta} />
}
