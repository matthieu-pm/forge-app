import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import type { IssueSearch } from "@/components/issues/team-issues"
import { TeamIssues } from "@/components/issues/team-issues"

export const Route = createFileRoute("/teams/$teamSlug/issues")({
  validateSearch: (search: Record<string, unknown>): IssueSearch => ({
    view: typeof search.view === "string" ? search.view : "active",
    issue: typeof search.issue === "string" ? search.issue : undefined,
  }),
  component: TeamIssuesPage,
})

function TeamIssuesPage() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <TeamIssues
      key={team.id}
      team={team}
      search={search}
      onNavigate={(next) => {
        void navigate({ search: next })
      }}
    />
  )
}
