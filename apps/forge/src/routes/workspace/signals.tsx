import { createFileRoute } from "@tanstack/react-router"
import { SignalsPage as SignalsView } from "@/components/signals/signals-page"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { readSignalsSearch } from "@/lib/signals-demo"

export const Route = createFileRoute("/workspace/signals")({
  beforeLoad: protectedRouteBeforeLoad,
  validateSearch: readSignalsSearch,
  component: SignalsPage,
})

function SignalsPage() {
  const { authState } = Route.useRouteContext()
  const { preview } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <SignalsView
      scope={{
        workspaceId: authState.workspace?.id ?? "personal",
        userId: authState.user!.id,
      }}
      preview={preview}
      onPreviewChange={(next) => {
        void navigate({ search: next ? { preview: true } : {} })
      }}
    />
  )
}
