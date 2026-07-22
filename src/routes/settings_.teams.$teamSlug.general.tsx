import { createFileRoute, getRouteApi } from "@tanstack/react-router"

import { TeamGeneralSettings } from "@/components/team-general-settings"

export const Route = createFileRoute("/settings_/teams/$teamSlug/general")({
  component: TeamGeneralSettingsPage,
})

const teamSettingsRoute = getRouteApi("/settings_/teams/$teamSlug")

function TeamGeneralSettingsPage() {
  const { team } = teamSettingsRoute.useLoaderData()

  return <TeamGeneralSettings team={team} />
}
