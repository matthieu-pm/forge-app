import { createFileRoute } from "@tanstack/react-router"
import { SignalsSettings } from "@/components/signals-settings"

export const Route = createFileRoute("/settings/signals")({
  component: SignalsSettingsPage,
})

function SignalsSettingsPage() {
  const { authState } = Route.useRouteContext()
  const workspaceId = authState.workspace?.id ?? "personal"
  return (
    <SignalsSettings
      key={`${authState.user!.id}:${workspaceId}`}
      userId={authState.user!.id}
      workspaceId={workspaceId}
    />
  )
}
