import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/agent")

export const Route = createFileRoute("/agent")({
  beforeLoad: protectedRouteBeforeLoad,
  component: AgentPage,
})

function AgentPage() {
  return <PagePlaceholder {...pageMeta} />
}
