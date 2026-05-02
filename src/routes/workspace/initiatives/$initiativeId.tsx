import { createFileRoute } from "@tanstack/react-router"

import { InitiativeDetailPage } from "@/components/initiative-detail-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/workspace/initiatives/$initiativeId")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InitiativeDetailPage,
})
