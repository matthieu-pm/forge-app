import { z } from "zod"
import {
  defaultIssueDisplay,
  displaySchema,
  emptyIssueFilters,
  filtersSchema,
} from "./team-issues"
import type { TeamIssue } from "./team-issues"

export const myIssueViews = [
  "assigned",
  "created",
  "subscribed",
  "activity",
] as const
export type MyIssueView = (typeof myIssueViews)[number]
export type MyIssueSearch = { view: MyIssueView; issue?: string }
export function readMyIssueSearch(
  search: Record<string, unknown>
): MyIssueSearch {
  return {
    view: myIssueViews.includes(search.view as MyIssueView)
      ? (search.view as MyIssueView)
      : "assigned",
    ...(typeof search.issue === "string" && search.issue.length <= 200
      ? { issue: search.issue }
      : {}),
  }
}
function isCurrent(value: string, userId: string) {
  return Boolean(userId) && (value === userId || value === "You")
}
export function isMyIssue(issue: TeamIssue, view: MyIssueView, userId: string) {
  if (!userId) return false
  if (view === "created") return isCurrent(issue.creator, userId)
  if (view === "subscribed")
    return issue.subscribers
      .split(",")
      .some((id) => isCurrent(id.trim(), userId))
  if (view === "activity")
    return (
      isCurrent(issue.creator, userId) ||
      issue.activity.some((event) => isCurrent(event.author, userId)) ||
      issue.comments.some((comment) => isCurrent(comment.author, userId))
    )
  return isCurrent(issue.assignee ?? "", userId)
}
export function myIssueActivity(issue: TeamIssue, userId: string) {
  return [
    ...(isCurrent(issue.creator, userId)
      ? [
          {
            id: "issue-created",
            at: issue.createdAt,
            text: "created the issue",
          },
        ]
      : []),
    ...issue.activity
      .filter((event) => isCurrent(event.author, userId))
      .map((event) => ({
        id: `update-${event.id}`,
        at: event.createdAt,
        text: event.text,
      })),
    ...issue.comments
      .filter(
        (comment) => !comment.deleted && isCurrent(comment.author, userId)
      )
      .map((comment) => ({
        id: `comment-${comment.id}`,
        at: comment.createdAt,
        text: comment.parentId
          ? "replied to a comment"
          : "commented on the issue",
      })),
  ]
}
export const myIssuePreferencesSchema = z.object({
  version: z.literal(1),
  display: displaySchema,
  defaultDisplay: displaySchema,
  filters: filtersSchema,
  details: z.boolean(),
})
export type MyIssuePreferences = z.infer<typeof myIssuePreferencesSchema>
export const myIssuePreferencesKey = (userId: string) =>
  `forge:my-issues:v1:${userId}`
export const defaultMyIssuePreferences = (): MyIssuePreferences => ({
  version: 1,
  display: defaultIssueDisplay(),
  defaultDisplay: defaultIssueDisplay(),
  filters: emptyIssueFilters(),
  details: false,
})
