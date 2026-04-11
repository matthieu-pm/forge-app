import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/calls")

export const Route = createFileRoute("/workspace/calls")({
  component: CallsPage,
})

function CallsPage() {
  return <PagePlaceholder {...pageMeta} />
}
