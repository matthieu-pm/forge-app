import { useEffect, useState } from "react"
import { Reviews } from "./reviews"
import type { AuthState } from "@/lib/auth-types"
import type { Review } from "@/lib/reviews-view"
import { createSimulatedReviews } from "@/lib/reviews-demo"

export function ReviewsPage({
  authState,
  view,
}: {
  authState: AuthState
  view: "for-you" | "created"
}) {
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
    />
  )
}
