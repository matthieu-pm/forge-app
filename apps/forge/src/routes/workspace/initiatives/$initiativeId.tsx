import { createFileRoute } from "@tanstack/react-router"

import { InitiativeDetail } from "@/components/initiatives/initiative-detail"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadInitiativeDirectory } from "@/lib/initiative-directory"
import { useInitiatives } from "@/lib/initiatives-state"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/workspace/initiatives/$initiativeId")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: loadInitiativeDirectory,
  staleTime: 30_000,
  validateSearch: (search: Record<string, unknown>): { tab: string } => ({
    tab:
      typeof search.tab === "string" &&
      (search.tab === "projects" ||
        search.tab === "updates" ||
        search.tab.startsWith("view:"))
        ? search.tab
        : search.tab === "activity"
          ? "updates"
          : "overview",
  }),
  component: InitiativePage,
})

function InitiativePage() {
  const { authState } = Route.useRouteContext()
  if (!authState.workspace || !authState.user) return null
  return (
    <Detail
      key={`${authState.workspace.id}:${authState.user.id}`}
      workspaceId={authState.workspace.id}
      userId={authState.user.id}
    />
  )
}

function Detail({
  workspaceId,
  userId,
}: {
  workspaceId: string
  userId: string
}) {
  const directory = Route.useLoaderData()
  const params = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const store = useInitiatives(workspaceId, userId)
  const item = store.state.initiatives.find(
    (initiative) => initiative.id === params.initiativeId
  )
  function back() {
    void navigate({ to: "/workspace/initiatives", search: { view: "all" } })
  }
  if (!store.ready)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        Loading initiative...
      </p>
    )
  if (!item)
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-11 items-center border-b border-border/40 px-4 text-sm">
          Initiatives
        </header>
        <div className="p-8">
          <p
            role={store.error ? "alert" : "status"}
            className="text-sm text-muted-foreground"
          >
            {store.error ||
              "This initiative is no longer available on this device."}
          </p>
          <Button variant="ghost" className="mt-4" onClick={back}>
            Back to initiatives
          </Button>
        </div>
      </main>
    )
  return (
    <InitiativeDetail
      key={item.id}
      item={item}
      store={store}
      userId={userId}
      people={directory.people}
      teams={directory.teams}
      tab={
        search.tab.startsWith("view:") &&
        !item.views.some((view) => `view:${view.id}` === search.tab)
          ? "overview"
          : search.tab
      }
      onTab={(tab) => {
        void navigate({ search: { tab } })
      }}
      onBack={back}
    />
  )
}
