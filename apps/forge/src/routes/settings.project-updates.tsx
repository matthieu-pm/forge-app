import { createFileRoute } from "@tanstack/react-router"

import { ProjectUpdatesSettings } from "@/components/project-updates-settings"

export const Route = createFileRoute("/settings/project-updates")({
  loader: ({ context }) => {
    const workspace =
      "authState" in context ? context.authState.workspace : null

    if (!workspace) {
      throw new Error("The active workspace could not be loaded.")
    }

    return { workspaceId: workspace.id }
  },
  component: ProjectUpdatesSettingsPage,
})

function ProjectUpdatesSettingsPage() {
  const { workspaceId } = Route.useLoaderData()

  return <ProjectUpdatesSettings workspaceId={workspaceId} />
}
