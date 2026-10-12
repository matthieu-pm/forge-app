import { createFileRoute, getRouteApi, notFound } from "@tanstack/react-router"
import { RecurringIssueEditor } from "@/components/recurring-issues/recurring-issue-editor"

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
const issuesRoute = getRouteApi("/settings_/teams/$teamSlug/recurring-issues")
export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/recurring-issues/$recurringId"
)({ component: Page })
function Page() {
  const { team } = teamRoute.useLoaderData()
  const { directory, issues } = issuesRoute.useLoaderData()
  const { recurringId } = Route.useParams()
  const saved = issues.find((issue) => issue.id === recurringId)
  if (recurringId !== "new" && !saved) throw notFound()
  return (
    <RecurringIssueEditor
      key={`${team.id}-${recurringId}`}
      team={team}
      directory={directory}
      saved={saved}
    />
  )
}
