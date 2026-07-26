import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/my-issues")

export const Route = createFileRoute("/my-issues")({
  beforeLoad: protectedRouteBeforeLoad,
  component: MyIssuesPage,
})

function MyIssuesPage() {
  return <PagePlaceholder {...pageMeta} />
}
