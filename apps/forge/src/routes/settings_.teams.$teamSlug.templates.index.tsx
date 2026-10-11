import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamTemplates } from "@/components/templates/team-templates"

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
const templatesRoute = getRouteApi("/settings_/teams/$teamSlug/templates")
export const Route = createFileRoute("/settings_/teams/$teamSlug/templates/")({
  component: Page,
})
function Page() {
  const { team } = teamRoute.useLoaderData()
  const directory = templatesRoute.useLoaderData()
  return <TeamTemplates team={team} directory={directory} />
}
