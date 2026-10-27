import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import {
  CallsLoadError,
  CallsLoading,
} from "@/components/calls/calls-route-state"
import { CallsPage } from "@/components/calls/calls-page"
import { loadCalls } from "@/lib/calls-state"
import { getTeam } from "@/lib/team-state"
import { getAuthState } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/calls")({
  validateSearch: (search: Record<string, unknown>) => ({
    call:
      typeof search.call === "string" && /^[\da-f-]{36}$/i.test(search.call)
        ? search.call
        : undefined,
  }),
  loader: async ({ params }) => {
    const [team, authState] = await Promise.all([
      getTeam({ data: { slug: params.teamSlug } }),
      getAuthState(),
    ])
    if (!team) throw new Error("This team is not available.")
    return {
      directory: await loadCalls({ data: { teamId: team.id } }),
      creator: authState.user?.id ?? "You",
    }
  },
  pendingComponent: CallsLoading,
  pendingMs: 150,
  errorComponent: CallsLoadError,
  component: TeamCallsPage,
})
function TeamCallsPage() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const { directory, creator } = Route.useLoaderData()
  const { call } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <CallsPage
      key={team.id}
      initialDirectory={directory}
      teams={[team]}
      teamId={team.id}
      creator={creator}
      selectedId={call}
      onSelect={(id) => {
        void navigate({ search: { call: id } })
      }}
    />
  )
}
