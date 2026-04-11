import { createFileRoute } from "@tanstack/react-router"
import { PagePlaceholder } from "@/components/page-placeholder"
import { getPageMeta } from "@/lib/app-navigation"

const pageMeta = getPageMeta("/workspace/projects")

export const Route = createFileRoute("/workspace/projects")({
  component: ProjectsPage,
})

function ProjectsPage() {
  return <PagePlaceholder {...pageMeta} />
}
