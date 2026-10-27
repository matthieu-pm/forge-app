import { Reviews } from "./reviews"
import type { AuthState } from "@/lib/auth-types"

export function ReviewsPage({
  authState,
  view,
}: {
  authState: AuthState
  view: "for-you" | "created"
}) {
  if (!authState.workspace || !authState.user) return null
  return (
    <Reviews
      key={`${authState.workspace.id}:${authState.user.id}:${view}`}
      scope={{ workspaceId: authState.workspace.id, userId: authState.user.id }}
      view={view}
    />
  )
}
