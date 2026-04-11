import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/members")

export const Route = createFileRoute("/workspace/members")({
  component: MembersPage,
})

function MembersPage() {
  return <PagePlaceholder {...pageMeta} />
}
