import { createFileRoute, notFound } from "@tanstack/react-router"
import { TemplateEditor } from "@/components/templates/template-editor"
import { loadTemplates } from "@/lib/template-state"

export const Route = createFileRoute("/settings/templates/project/$templateId")(
  {
    loader: () => loadTemplates({ data: {} }),
    component: Page,
  }
)
function Page() {
  const directory = Route.useLoaderData()
  const { templateId } = Route.useParams()
  const saved = directory.templates.find(
    (template) =>
      template.id === templateId && template.payload.kind === "project"
  )
  if (templateId !== "new" && !saved) throw notFound()
  return (
    <TemplateEditor
      key={templateId}
      workspace
      kind="project"
      directory={directory}
      saved={saved}
    />
  )
}
