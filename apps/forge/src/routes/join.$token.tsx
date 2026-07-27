import { createFileRoute } from "@tanstack/react-router"

import { JoinWorkspace } from "@/components/join-workspace"
import { authenticatedRouteBeforeLoad } from "@/lib/auth-state"
import { loadWorkspaceInvite } from "@/lib/workspace-join-state"

export const Route = createFileRoute("/join/$token")({
  beforeLoad: authenticatedRouteBeforeLoad,
  loader: ({ params }) =>
    loadWorkspaceInvite({ data: { token: params.token } }),
  component: JoinWorkspacePage,
})

function JoinWorkspacePage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <JoinWorkspace
        invite={Route.useLoaderData()}
        token={Route.useParams().token}
      />
    </main>
  )
}
