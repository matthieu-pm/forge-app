import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/initiatives")

export const Route = createFileRoute("/workspace/initiatives")({
  component: InitiativesPage,
})

function InitiativesPage() {
  return <PagePlaceholder {...pageMeta} />
}
