import { createFileRoute, getRouteApi } from "@tanstack/react-router"

import { TeamSettingsOverview } from "@/components/team-settings-overview"

export const Route = createFileRoute("/settings_/teams/$teamSlug/")({
  component: TeamSettingsPage,
})

const teamSettingsRoute = getRouteApi("/settings_/teams/$teamSlug")
const teamsSettingsRoute = getRouteApi("/settings_/teams")

function TeamSettingsPage() {
  const { team } = teamSettingsRoute.useLoaderData()
  const directory = teamsSettingsRoute.useLoaderData()
  const memberCount =
    directory.items.find((item) => item.id === team.id)?.memberCount ?? 0

  return <TeamSettingsOverview team={team} memberCount={memberCount} />
}
