import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/views")

export const Route = createFileRoute("/workspace/views")({
  component: ViewsPage,
})

function ViewsPage() {
  return <PagePlaceholder {...pageMeta} />
}
