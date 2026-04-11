import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/members")

export const Route = createFileRoute("/workspace/members")({
  beforeLoad: protectedRouteBeforeLoad,
  component: MembersPage,
})

function MembersPage() {
  return <PagePlaceholder {...pageMeta} />
}
