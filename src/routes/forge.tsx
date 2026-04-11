import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/forge")

export const Route = createFileRoute("/forge")({
  component: ForgePage,
})

function ForgePage() {
  return <PagePlaceholder {...pageMeta} />
}
