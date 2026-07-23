import { createFileRoute } from "@tanstack/react-router"

import { PagePlaceholder } from "@/components/page-placeholder"

export const Route = createFileRoute("/teams/$teamSlug/projects")({
  component: TeamProjectsPage,
})

function TeamProjectsPage() {
  return <PagePlaceholder />
}
