import { createFileRoute, getRouteApi, notFound } from "@tanstack/react-router"
import { TemplateEditor } from "@/components/templates/template-editor"
import { templateKindSchema } from "@/lib/template-contract"

const teamRoute = getRouteApi("/settings_/teams/$teamSlug")
const templatesRoute = getRouteApi("/settings_/teams/$teamSlug/templates")
export const Route = createFileRoute(
  "/settings_/teams/$teamSlug/templates/$kind/$templateId"
)({
  validateSearch: (search: Record<string, unknown>) => ({
    form: search.form === true || search.form === "true",
  }),
  beforeLoad: ({ params }) => {
    if (!templateKindSchema.safeParse(params.kind).success) throw notFound()
  },
  component: Page,
})
function Page() {
  const { team } = teamRoute.useLoaderData()
  const directory = templatesRoute.useLoaderData()
  const { kind, templateId } = Route.useParams()
  const { form } = Route.useSearch()
  const saved = directory.templates.find(
    (t) => t.id === templateId && t.payload.kind === kind
  )
  if (templateId !== "new" && !saved) throw notFound()
  return (
    <TemplateEditor
      key={`${team.id}-${kind}-${templateId}`}
      kind={templateKindSchema.parse(kind)}
      team={team}
      directory={directory}
      saved={saved}
      form={form}
    />
  )
}
