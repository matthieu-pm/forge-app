import { createFileRoute } from "@tanstack/react-router"
import { ProjectsPage } from "@/components/projects/projects-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"

export const Route = createFileRoute("/workspace/projects")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: loadInitiativeDirectory,
  staleTime: 30_000,
  component: Page,
})
function Page() {
  const navigate = Route.useNavigate()
  const { authState } = Route.useRouteContext()
  const directory = Route.useLoaderData()
  if (!authState.workspace || !authState.user) return null
  return (
    <ProjectsPage
      key={`${authState.workspace.id}:${authState.user.id}`}
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
          search: { tab },
        })
      }}
      people={directory.people}
      teams={directory.teams}
      directoryError={directory.error.replace("Initiatives", "Projects")}
    />
  )
}
