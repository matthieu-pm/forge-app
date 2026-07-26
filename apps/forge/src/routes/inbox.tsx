import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/inbox")

export const Route = createFileRoute("/inbox")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InboxPage,
})

function InboxPage() {
  return <PagePlaceholder {...pageMeta} />
}
