import { createFileRoute } from "@tanstack/react-router"

import { TeamGeneralSettings } from "@/components/team-general-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/general")({
  component: TeamGeneralSettingsPage,
})

function TeamGeneralSettingsPage() {
  const { team } = Route.useRouteContext()

  return <TeamGeneralSettings team={team} />
}
