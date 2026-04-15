import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { ProjectsEmptyState } from "@/components/projects-empty-state"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/projects")({
  beforeLoad: protectedRouteBeforeLoad,
  component: TeamProjectsPage,
})

function TeamProjectsPage() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const isTeamProjectsRoute =
    /^\/teams\/(product|engineering|operations)\/projects$/.test(pathname)

  if (!isTeamProjectsRoute) {
    return <PagePlaceholder {...getPageMeta(pathname)} />
  }

  return <ProjectsEmptyState />
}
