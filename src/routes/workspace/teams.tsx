import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/teams")

export const Route = createFileRoute("/workspace/teams")({
  component: TeamsPage,
})

function TeamsPage() {
  return <PagePlaceholder {...pageMeta} />
}
