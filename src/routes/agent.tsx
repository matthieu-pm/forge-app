import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/agent")

export const Route = createFileRoute("/agent")({
  component: AgentPage,
})

function AgentPage() {
  return <PagePlaceholder {...pageMeta} />
}
