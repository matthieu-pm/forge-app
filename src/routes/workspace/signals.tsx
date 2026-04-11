import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/signals")

export const Route = createFileRoute("/workspace/signals")({
  component: SignalsPage,
})

function SignalsPage() {
  return <PagePlaceholder {...pageMeta} />
}
