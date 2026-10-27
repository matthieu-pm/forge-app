import { useEffect, useState } from "react"
import { Reviews } from "./reviews"
import type { AuthState } from "@/lib/auth-types"
import type { Review } from "@/lib/reviews-view"
import type { ReviewSearch } from "@/lib/review-detail"
import { useAgent } from "@/components/agent/agent-provider"
import { createSimulatedReviews } from "@/lib/reviews-demo"

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
  const userId = authState.user?.id
  const userName = authState.user?.name ?? null
  const [preview, setPreview] = useState<{
    userId: string
    entries: Array<Review>
  } | null>(null)
  useEffect(() => {
    if (userId)
      setPreview({
        userId,
        entries: createSimulatedReviews({ id: userId, name: userName }),
      })
  }, [userId, userName])
  if (!authState.workspace || !authState.user) return null
  return (
    <Reviews
      key={`${authState.workspace.id}:${authState.user.id}:${view}`}
      scope={{ workspaceId: authState.workspace.id, userId: authState.user.id }}
      view={view}
      entries={preview && preview.userId === userId ? preview.entries : []}
      simulated
      selection={selection}
      onNavigate={onNavigate}
      currentUserName={userName ?? "You"}
      onOpenAgent={(review) => {
        if (!agent.draft.trim())
          agent.setDraft(
            `Help me review the simulated pull request #${review.number}: ${review.title}.\n\n${review.description}`
          )
        agent.openComposer("floating")
      }}
    />
  )
}
