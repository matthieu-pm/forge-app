import { createFileRoute } from "@tanstack/react-router"

import { WorkspaceSettings } from "@/components/workspace-settings"

export const Route = createFileRoute("/settings/workspace")({
  loader: ({ context }) => {
    const workspace =
      "authState" in context ? context.authState.workspace : null

    if (!workspace) {
      throw new Error("The active workspace could not be loaded.")
    }

    return { workspace }
  },
  component: WorkspaceSettingsPage,
})

function WorkspaceSettingsPage() {
  const { workspace } = Route.useLoaderData()

  return <WorkspaceSettings workspace={workspace} />
}
