import { createFileRoute } from "@tanstack/react-router"
import { WorkspaceIssueTemplates } from "@/components/templates/workspace-issue-templates"
import { loadTemplates } from "@/lib/template-state"

export const Route = createFileRoute("/settings/issue-templates")({
  loader: () => loadTemplates({ data: {} }),
  component: Page,
})
function Page() {
  return <WorkspaceIssueTemplates directory={Route.useLoaderData()} />
}
