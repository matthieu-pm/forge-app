import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { RecurringIssues } from "@/components/recurring-issues/recurring-issues"

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
const issuesRoute = getRouteApi("/settings_/teams/$teamSlug/recurring-issues")
export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/recurring-issues/"
)({ component: Page })
function Page() {
  const { team } = teamRoute.useLoaderData()
  const { directory, issues } = issuesRoute.useLoaderData()
  return (
    <RecurringIssues
      team={team}
      issues={issues}
      canManage={directory.canManage}
    />
  )
}
