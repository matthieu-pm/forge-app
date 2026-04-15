import { createFileRoute, useRouterState } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"
import { ProjectsEmptyState } from "@/components/projects-empty-state"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { useProjectsPageHeader } from "@/lib/projects-page-header"

export const Route = createFileRoute("/workspace/projects")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ProjectsPage,
})

function ProjectsPage() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const isProjectsRoute = pathname === "/workspace/projects"
  useProjectsPageHeader(isProjectsRoute)

  if (!isProjectsRoute) {
    return <PagePlaceholder {...getPageMeta(pathname)} />
  }

  return <ProjectsEmptyState />
}
