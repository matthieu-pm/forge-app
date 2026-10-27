import { createFileRoute } from "@tanstack/react-router"
import { Inbox } from "@/components/inbox/inbox"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/inbox")({
  beforeLoad: protectedRouteBeforeLoad,
  component: InboxPage,
})

function InboxPage() {
  const { authState } = Route.useRouteContext()
  if (!authState.workspace || !authState.user) return null
  return (
    <Inbox
      key={`${authState.workspace.id}:${authState.user.id}`}
      scope={{ workspaceId: authState.workspace.id, userId: authState.user.id }}
    />
  )
}
