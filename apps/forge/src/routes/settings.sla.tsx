import { createFileRoute } from "@tanstack/react-router"

import { SlaSettings } from "@/components/sla-settings"

export const Route = createFileRoute("/settings/sla")({
  loader: ({ context }) => {
    const workspace =
      "authState" in context ? context.authState.workspace : null

    if (!workspace) {
      throw new Error("The active workspace could not be loaded.")
    }

    return { workspaceId: workspace.id }
  },
  component: SlaSettingsPage,
})

function SlaSettingsPage() {
  const { workspaceId } = Route.useLoaderData()

  return <SlaSettings workspaceId={workspaceId} />
}
