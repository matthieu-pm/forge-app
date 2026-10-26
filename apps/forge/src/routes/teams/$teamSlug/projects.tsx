import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { ProjectsPage } from "@/components/projects/projects-page"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/projects")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: loadInitiativeDirectory,
  staleTime: 30_000,
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const { authState } = Route.useRouteContext()
  const directory = Route.useLoaderData()
  if (!authState.workspace || !authState.user) return null
  return (
    <ProjectsPage
      key={`${authState.workspace.id}:${authState.user.id}:${team.id}`}
      workspaceId={authState.workspace.id}
      user={{
        id: authState.user.id,
        name: authState.user.name || "You",
        image: authState.user.image,
      }}
      people={directory.people}
      teams={directory.teams}
      team={team}
      directoryError={directory.error.replace("Initiatives", "Projects")}
    />
  )
}
