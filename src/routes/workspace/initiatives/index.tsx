import { createFileRoute } from "@tanstack/react-router"

import { InitiativesPage } from "@/components/initiatives-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/workspace/initiatives/")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InitiativesPage,
})
