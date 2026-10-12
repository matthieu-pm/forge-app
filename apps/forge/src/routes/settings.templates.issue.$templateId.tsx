import { createFileRoute, notFound } from "@tanstack/react-router"
import { TemplateEditor } from "@/components/templates/template-editor"
import { loadTemplates } from "@/lib/template-state"

export const Route = createFileRoute("/settings/templates/issue/$templateId")({
  validateSearch: (search: Record<string, unknown>) => ({
    form: search.form === true || search.form === "true",
  }),
  loader: () => loadTemplates({ data: {} }),
  component: Page,
})
function Page() {
  const directory = Route.useLoaderData()
  const { templateId } = Route.useParams()
  const { form } = Route.useSearch()
  const saved = directory.templates.find(
    (t) => t.id === templateId && t.payload.kind === "issue"
  )
  if (templateId !== "new" && !saved) throw notFound()
  return (
    <TemplateEditor
      key={templateId}
      workspace
      kind="issue"
      directory={directory}
      saved={saved}
      form={form}
    />
  )
}
