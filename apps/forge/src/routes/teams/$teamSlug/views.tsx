import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { ViewsPage, viewsSearchSchema } from "@/components/views/views-page"
import { getNavigationAuthState } from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"

export const Route = createFileRoute("/teams/$teamSlug/views")({
  loader: async () => {
    const [authState, directory] = await Promise.all([
      getNavigationAuthState(),
      loadInitiativeDirectory(),
    ])
    return { authState, directory }
  },
  staleTime: 30_000,
  validateSearch: viewsSearchSchema,
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const { authState, directory } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!authState.workspace || !authState.user) return null
  return (
    <ViewsPage
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
      directoryError={directory.error.replace("Initiatives", "Views")}
      search={search}
      onNavigate={(next) => void navigate({ search: next })}
    />
  )
}
