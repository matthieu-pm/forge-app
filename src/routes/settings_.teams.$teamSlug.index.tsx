import { createFileRoute, getRouteApi } from "@tanstack/react-router"

import { TeamSettingsOverview } from "@/components/team-settings-overview"

export const Route = createFileRoute("/settings_/teams/$teamSlug/")({
  component: TeamSettingsPage,
})

const teamSettingsRoute = getRouteApi("/settings_/teams/$teamSlug")

function TeamSettingsPage() {
  const { team } = teamSettingsRoute.useLoaderData()

  return <TeamSettingsOverview team={team} />
}
