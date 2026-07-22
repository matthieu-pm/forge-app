import { createFileRoute } from "@tanstack/react-router"

import { TeamSettingsOverview } from "@/components/team-settings-overview"

export const Route = createFileRoute("/settings_/teams/$teamSlug/")({
  component: TeamSettingsPage,
})

function TeamSettingsPage() {
  const { team } = Route.useRouteContext()

  return <TeamSettingsOverview team={team} />
}
