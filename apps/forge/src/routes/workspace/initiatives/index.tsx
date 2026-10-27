import { createFileRoute } from "@tanstack/react-router"

import type { InitiativeView } from "@/lib/initiatives"
import { InitiativesPage as Initiatives } from "@/components/initiatives/initiatives-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"

export const Route = createFileRoute("/workspace/initiatives/")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: loadInitiativeDirectory,
  staleTime: 30_000,
  validateSearch: (
    search: Record<string, unknown>
  ): { view: InitiativeView } => ({
    view:
      search.view === "planned" || search.view === "all"
        ? search.view
        : "active",
  }),
  component: InitiativesPage,
})

function InitiativesPage() {
  const { authState } = Route.useRouteContext()
  const directory = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!authState.workspace || !authState.user) return null
  return (
    <Initiatives
      key={`${authState.workspace.id}:${authState.user.id}`}
      workspaceId={authState.workspace.id}
      user={{
        id: authState.user.id,
        name: authState.user.name || "You",
        image: authState.user.image,
      }}
      people={directory.people}
      teams={directory.teams}
      directoryError={directory.error}
      view={search.view}
      onView={(view) => {
        void navigate({ search: { view } })
      }}
      onOpen={(item, tab) => {
        void navigate({
          to: "/workspace/initiatives/$initiativeId",
          params: { initiativeId: item.id },
          search: { tab },
        })
      }}
    />
  )
}
