import { Reviews } from "./reviews"
import type { AuthState } from "@/lib/auth-types"
import type { ReviewSearch } from "@/lib/review-detail"
import { useAgent } from "@/components/agent/agent-provider"

export function ReviewsPage({
  authState,
  view,
  selection,
  onNavigate,
}: {
  authState: AuthState
  view: "for-you" | "created"
  selection?: ReviewSearch
  onNavigate?: (search: ReviewSearch) => void
}) {
  const agent = useAgent()
  const userName = authState.user?.name ?? null
  if (!authState.workspace || !authState.user) return null
  return (
    <Reviews
      key={`${authState.workspace.id}:${authState.user.id}:${view}`}
      scope={{ workspaceId: authState.workspace.id, userId: authState.user.id }}
      view={view}
      selection={selection}
      onNavigate={onNavigate}
      currentUserName={userName ?? "You"}
      onOpenAgent={(review) => {
        if (!agent.draft.trim())
          agent.setDraft(
            `Help me review pull request #${review.number}: ${review.title}.\n\n${review.description}`
          )
        agent.openComposer("floating")
      }}
    />
  )
}
