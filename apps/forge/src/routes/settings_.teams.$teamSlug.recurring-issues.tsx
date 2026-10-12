import { Outlet, createFileRoute } from "@tanstack/react-router"
import { loadTemplates } from "@/lib/template-state"
import { loadRecurringIssues } from "@/lib/recurring-issue-state"

export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/recurring-issues"
)({
  loader: async ({ params }) => {
    const data = { slug: params.teamSlug }
    const [issues, directory] = await Promise.all([
      loadRecurringIssues({ data }),
      loadTemplates({ data }),
    ])
    return { issues, directory }
  },
  component: Outlet,
})
