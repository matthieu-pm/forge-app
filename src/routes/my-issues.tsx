import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/my-issues")

export const Route = createFileRoute("/my-issues")({
  component: MyIssuesPage,
})

function MyIssuesPage() {
  return <PagePlaceholder {...pageMeta} />
}
