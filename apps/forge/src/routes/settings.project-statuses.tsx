import { createFileRoute } from "@tanstack/react-router"
import { ProjectStatusesSettings } from "@/components/project-statuses-settings"

export const Route = createFileRoute("/settings/project-statuses")({
  component: ProjectStatusesPage,
})
function ProjectStatusesPage() {
  const { authState } = Route.useRouteContext()
  return (
    <ProjectStatusesSettings
      key={authState.workspace!.id}
      workspaceId={authState.workspace!.id}
    />
  )
}
