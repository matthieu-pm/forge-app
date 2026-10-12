import { createFileRoute } from "@tanstack/react-router"
import { WorkspaceProjectTemplates } from "@/components/templates/workspace-project-templates"
import { loadTemplates } from "@/lib/template-state"

export const Route = createFileRoute("/settings/project-templates")({
  loader: () => loadTemplates({ data: {} }),
  component: Page,
})
function Page() {
  return <WorkspaceProjectTemplates directory={Route.useLoaderData()} />
}
