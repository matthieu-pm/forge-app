import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/initiatives")

export const Route = createFileRoute("/workspace/initiatives")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InitiativesPage,
})

function InitiativesPage() {
  return <PagePlaceholder {...pageMeta} />
}
