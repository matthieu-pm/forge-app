import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { TeamDocuments } from "@/components/team-home-documents"

export const Route = createFileRoute("/teams/$teamSlug/documents")({
  validateSearch: (search: Record<string, unknown>): { document?: string } => ({
    ...(typeof search.document === "string" && search.document.length <= 200
      ? { document: search.document }
      : {}),
  }),
  component: Page,
})
function Page() {
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <TeamDocuments
      key={team.id}
      team={team}
      documentId={search.document}
      onOpenDocument={(document) => {
        void navigate({ search: document ? { document } : {} })
      }}
    />
  )
}
