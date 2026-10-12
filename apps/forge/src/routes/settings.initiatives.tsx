import { createFileRoute } from "@tanstack/react-router"

import { InitiativesSettings } from "@/components/initiatives-settings"

export const Route = createFileRoute("/settings/initiatives")({
  loader: ({ context }) => {
    const workspace =
      "authState" in context ? context.authState.workspace : null

    if (!workspace) {
      throw new Error("The active workspace could not be loaded.")
    }

    return { workspaceId: workspace.id }
  },
  component: InitiativesSettingsPage,
})

function InitiativesSettingsPage() {
  const { workspaceId } = Route.useLoaderData()

  return <InitiativesSettings workspaceId={workspaceId} />
}
