import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { protectedTeamRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/projects")({
  beforeLoad: protectedTeamRouteBeforeLoad,
  component: TeamProjectsPage,
})

function TeamProjectsPage() {
  return <PagePlaceholder />
}
