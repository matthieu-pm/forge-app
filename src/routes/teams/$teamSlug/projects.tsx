import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/projects")({
  beforeLoad: protectedRouteBeforeLoad,
  component: TeamProjectsPage,
})

function TeamProjectsPage() {
  return <PagePlaceholder />
}
