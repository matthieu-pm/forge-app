import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/workspace/initiatives/$initiativeId")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InitiativePage,
})

function InitiativePage() {
  return <PagePlaceholder />
}
