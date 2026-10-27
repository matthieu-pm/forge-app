import { z } from "zod"

export const reviewDisplaySchema = z.object({
  groupBy: z.enum(["focus", "status", "author", "repository", "none"]),
  orderBy: z.enum(["importance", "updated", "opened"]),
  closedReviews: z.enum(["none", "day", "week", "all"]),
  showDrafts: z.boolean(),
  showTeamReviews: z.boolean(),
  properties: z.array(
    z.enum(["repository", "id", "author", "timestamp", "labels", "status"])
  ),
})
export type ReviewDisplay = z.infer<typeof reviewDisplaySchema>
export const defaultReviewDisplay: ReviewDisplay = {
  groupBy: "focus",
  orderBy: "importance",
  closedReviews: "day",
  showDrafts: true,
  showTeamReviews: true,
  properties: ["timestamp"],
}
export type Review = {
  id: string
  number: number
  title: string
  description: string
  descriptionDoc?: Record<string, unknown>
  repository: string
  author: { id: string; name: string }
  reviewerIds: Array<string>
  participatedUserIds: Array<string>
  teamReview: boolean
  status: "open" | "draft" | "merged" | "closed"
  reviewState: "requested" | "changes-requested" | "approved" | "reviewed"
  labels: Array<string>
  openedAt: string
  updatedAt: string
  closedAt: string | null
  url: string
}
export type ReviewFilters = {
  status: string
  author: string
  repository: string
  content: string
}
export const emptyReviewFilters = (): ReviewFilters => ({
  status: "all",
  author: "all",
  repository: "all",
  content: "",
})
export function hasReviewFilters(filters: ReviewFilters) {
  return (
    filters.status !== "all" ||
    filters.author !== "all" ||
    filters.repository !== "all" ||
    Boolean(filters.content.trim())
  )
}
export function reviewDisplayKey(scope: {
  workspaceId: string
  userId: string
}) {
  return `forge:reviews-display:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`
}
export function readReviewDisplay(key: string): ReviewDisplay {
  try {
    const parsed = reviewDisplaySchema
      .partial()
      .safeParse(JSON.parse(localStorage.getItem(key) ?? "{}"))
    return parsed.success
      ? { ...defaultReviewDisplay, ...parsed.data }
      : defaultReviewDisplay
  } catch {
    return defaultReviewDisplay
  }
}
export function visibleReviews(
  entries: ReadonlyArray<Review>,
  userId: string,
  view: "for-you" | "created",
  filters: ReviewFilters,
  display: ReviewDisplay,
  now = Date.now()
) {
  return entries
    .filter((review) => {
      if (
        view === "created"
          ? review.author.id !== userId
          : !(
              review.author.id === userId ||
              review.reviewerIds.includes(userId) ||
              review.participatedUserIds.includes(userId) ||
              (display.showTeamReviews && review.teamReview)
            )
      )
        return false
      if (!display.showDrafts && review.status === "draft") return false
      if (review.status === "closed" || review.status === "merged") {
        const window = display.closedReviews === "day" ? 86400000 : 604800000
        if (
          display.closedReviews === "none" ||
          (display.closedReviews !== "all" &&
            (!review.closedAt || Date.parse(review.closedAt) < now - window))
        )
          return false
      }
      return (
        (filters.status === "all" || review.status === filters.status) &&
        (filters.author === "all" || review.author.id === filters.author) &&
        (filters.repository === "all" ||
          review.repository === filters.repository) &&
        `${review.title} ${review.description} ${review.repository} #${review.number}`
          .toLowerCase()
          .includes(filters.content.trim().toLowerCase())
      )
    })
    .sort((a, b) => {
      if (display.orderBy === "importance") {
        const rank = (r: Review) =>
          r.reviewerIds.includes(userId) && r.reviewState === "requested"
            ? 0
            : r.author.id === userId && r.reviewState === "changes-requested"
              ? 1
              : 2
        const difference = rank(a) - rank(b)
        if (difference) return difference
      }
      const field = display.orderBy === "opened" ? "openedAt" : "updatedAt"
      return (
        Date.parse(b[field]) - Date.parse(a[field]) || a.id.localeCompare(b.id)
      )
    })
}
export function reviewGroup(
  review: Review,
  groupBy: ReviewDisplay["groupBy"],
  userId: string
) {
  if (groupBy === "none") return ""
  if (groupBy === "repository") return review.repository
  if (groupBy === "author") return review.author.name
  if (groupBy === "status")
    return review.status[0].toUpperCase() + review.status.slice(1)
  if (review.status === "merged") return "Merged"
  if (review.status === "closed") return "Closed"
  if (review.status === "draft") return "Drafts"
  if (review.reviewState === "approved") return "Ready to merge"
  if (review.reviewerIds.includes(userId) && review.reviewState === "requested")
    return "Needs your review"
  if (review.author.id === userId && review.reviewState === "changes-requested")
    return "Needs your attention"
  return "Other reviews"
}
