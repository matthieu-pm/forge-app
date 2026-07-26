import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/signals")

export const Route = createFileRoute("/workspace/signals")({
  beforeLoad: protectedRouteBeforeLoad,
  component: SignalsPage,
})

function SignalsPage() {
  return <PagePlaceholder {...pageMeta} />
}
