import { createFileRoute } from "@tanstack/react-router"
import { MyIssues } from "@/components/issues/my-issues"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { readMyIssueSearch } from "@/lib/my-issues"
import { listTeams } from "@/lib/team-state"

export const Route = createFileRoute("/my-issues")({
  beforeLoad: protectedRouteBeforeLoad,
  validateSearch: readMyIssueSearch,
  loader: () => listTeams(),
  staleTime: 30_000,
  component: MyIssuesPage,
})
function MyIssuesPage() {
  const { authState } = Route.useRouteContext()
  const teams = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!authState.workspace || !authState.user) return null
  return (
    <MyIssues
      key={`${authState.workspace.id}:${authState.user.id}`}
      workspaceId={authState.workspace.id}
      user={{ ...authState.user, name: authState.user.name ?? "You" }}
      teams={teams}
      search={search}
      onNavigate={(next) => {
        void navigate({ search: next })
      }}
    />
  )
}
