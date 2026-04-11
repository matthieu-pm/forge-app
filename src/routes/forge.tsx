import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/forge")

export const Route = createFileRoute("/forge")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ForgePage,
})

function ForgePage() {
  return <PagePlaceholder {...pageMeta} />
}
