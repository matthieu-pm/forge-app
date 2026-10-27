import { createFileRoute } from "@tanstack/react-router"
import {
  CallsLoadError,
  CallsLoading,
} from "@/components/calls/calls-route-state"
import { CallsPage } from "@/components/calls/calls-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { loadCalls } from "@/lib/calls-state"
import { listTeams } from "@/lib/team-state"

export const Route = createFileRoute("/workspace/calls")({
  beforeLoad: protectedRouteBeforeLoad,
  validateSearch: (search: Record<string, unknown>) => ({
    call:
      typeof search.call === "string" && /^[\da-f-]{36}$/i.test(search.call)
        ? search.call
        : undefined,
    connection:
      search.connection === "connected" || search.connection === "error"
        ? search.connection
        : undefined,
  }),
  loader: async () => {
    const [directory, teams] = await Promise.all([
      loadCalls({ data: {} }),
      listTeams(),
    ])
    return { directory, teams }
  },
  pendingComponent: CallsLoading,
  pendingMs: 150,
  errorComponent: CallsLoadError,
  component: WorkspaceCallsPage,
})
function WorkspaceCallsPage() {
  const { directory, teams } = Route.useLoaderData()
  const { authState } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <CallsPage
      simulateWhenEmpty
      key={authState.workspace!.id}
      initialDirectory={directory}
      teams={teams}
      creator={authState.user?.id ?? "You"}
      scope={{
        workspaceId: authState.workspace!.id,
        userId: authState.user?.id ?? "You",
      }}
      selectedId={search.call}
      connectionStatus={search.connection}
      onSelect={(call) => {
        void navigate({ search: { call, connection: undefined } })
      }}
    />
  )
}
