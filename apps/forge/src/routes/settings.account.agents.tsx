import { createFileRoute } from "@tanstack/react-router"
import { AgentPersonalizationSettings } from "@/components/agent-personalization-settings"

export const Route = createFileRoute("/settings/account/agents")({
  component: AgentPersonalizationPage,
})
function AgentPersonalizationPage() {
  const { authState } = Route.useRouteContext()
  return (
    <AgentPersonalizationSettings
      key={authState.user!.id}
      userId={authState.user!.id}
    />
  )
}
