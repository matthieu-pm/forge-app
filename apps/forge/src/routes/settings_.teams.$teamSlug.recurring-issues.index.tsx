import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { RecurringIssueSettings } from "@/components/recurring-issues/recurring-issue-settings"
import {
  FeatureUnavailable,
  useFeatureMode,
} from "@/components/feature-availability"

export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/recurring-issues/"
)({
  beforeLoad: protectedRouteBeforeLoad,
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/settings_/teams/$teamSlug").useLoaderData()
  return useFeatureMode("recurringIssues") === "enabled" ? (
    <RecurringIssueSettings team={team} />
  ) : (
    <FeatureUnavailable feature="recurringIssues" />
  )
}
