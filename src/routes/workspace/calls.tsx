import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/calls")

export const Route = createFileRoute("/workspace/calls")({
  beforeLoad: protectedRouteBeforeLoad,
  component: CallsPage,
})

function CallsPage() {
  return <PagePlaceholder {...pageMeta} />
}
