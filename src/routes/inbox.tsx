import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/inbox")

export const Route = createFileRoute("/inbox")({
  component: InboxPage,
})

function InboxPage() {
  return <PagePlaceholder {...pageMeta} />
}
