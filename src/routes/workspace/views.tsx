import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/views")

export const Route = createFileRoute("/workspace/views")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ViewsPage,
})

function ViewsPage() {
  return <PagePlaceholder {...pageMeta} />
}
