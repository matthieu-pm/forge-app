import { createFileRoute } from "@tanstack/react-router"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { WorkspaceDocuments } from "@/components/workspace-documents"

export const Route = createFileRoute("/workspace/documents")({
  beforeLoad: protectedRouteBeforeLoad,
  validateSearch: (raw: Record<string, unknown>): { document?: string } => ({
    ...(typeof raw.document === "string" ? { document: raw.document } : {}),
  }),
  component: Page,
})
function Page() {
  const { document } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <WorkspaceDocuments
      documentId={document}
      onOpen={(id) => {
        void navigate({ search: id ? { document: id } : {} })
      }}
    />
  )
}
