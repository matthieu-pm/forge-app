import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { ProjectsPage } from "@/components/projects/projects-page"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"
import { getNavigationAuthState } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/projects")({
  loader: async () => {
    const [authState, directory] = await Promise.all([
      getNavigationAuthState(),
      loadInitiativeDirectory(),
    ])
    return { authState, directory }
  },
  staleTime: 30_000,
  component: Page,
})
function Page() {
  const navigate = Route.useNavigate()
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const { authState, directory } = Route.useLoaderData()
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
      onOpenProject={(project, tab = "overview") => {
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: project.id },
          search: { tab, team: team.slug },
        })
      }}
      people={directory.people}
      teams={directory.teams}
      team={team}
      directoryError={directory.error.replace("Initiatives", "Projects")}
    />
  )
}
