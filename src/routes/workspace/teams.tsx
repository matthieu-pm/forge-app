import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/teams")

export const Route = createFileRoute("/workspace/teams")({
  beforeLoad: protectedRouteBeforeLoad,
  component: TeamsPage,
})

function TeamsPage() {
  return <PagePlaceholder {...pageMeta} />
}
