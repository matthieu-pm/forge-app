import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

const pageMeta = getPageMeta("/workspace/projects")

export const Route = createFileRoute("/workspace/projects")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ProjectsPage,
})

function ProjectsPage() {
  return <PagePlaceholder {...pageMeta} />
}
