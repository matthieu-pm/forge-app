import { createFileRoute } from "@tanstack/react-router"
import { ViewsPage, viewsSearchSchema } from "@/components/views/views-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"

export const Route = createFileRoute("/workspace/views")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: loadInitiativeDirectory,
  staleTime: 30_000,
  validateSearch: viewsSearchSchema,
  component: Page,
})
function Page() {
  const { authState } = Route.useRouteContext()
  const directory = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!authState.workspace || !authState.user) return null
  return (
    <ViewsPage
      key={`${authState.workspace.id}:${authState.user.id}`}
      workspaceId={authState.workspace.id}
      user={{
        id: authState.user.id,
        name: authState.user.name || "You",
        image: authState.user.image,
      }}
      people={directory.people}
      teams={directory.teams}
      directoryError={directory.error.replace("Initiatives", "Views")}
      search={search}
      onNavigate={(next) => void navigate({ search: next })}
    />
  )
}
