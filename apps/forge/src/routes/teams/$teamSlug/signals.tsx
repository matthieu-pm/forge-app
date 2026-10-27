import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { SignalsPage as SignalsView } from "@/components/signals/signals-page"
import { readSignalsSearch } from "@/lib/signals-demo"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/teams/$teamSlug/signals")({
  beforeLoad: protectedRouteBeforeLoad,
  validateSearch: readSignalsSearch,
  component: SignalsPage,
})

function SignalsPage() {
  const { authState } = Route.useRouteContext()
  const { team } = getRouteApi("/teams/$teamSlug").useLoaderData()
  const { preview } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <SignalsView
      scope={{
        workspaceId: authState.workspace?.id ?? "personal",
        userId: authState.user!.id,
      }}
      team={team}
      preview={preview}
      onPreviewChange={(next) => {
        void navigate({ search: next ? { preview: true } : {} })
      }}
    />
  )
}
