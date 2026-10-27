import { z } from "zod"
import type { Review } from "./reviews-view"

export type DiffLine = {
  kind: "context" | "add" | "remove"
  content: string
  oldLine?: number
  newLine?: number
}
export type ReviewFile = {
  path: string
  category: "Implementation" | "Tests" | "Documentation" | "Generated"
  language: string
  generated?: boolean
  commit: string
  lines: Array<DiffLine>
  hiddenBefore?: Array<DiffLine>
}
export type ReviewPerson = { id: string; name: string }
export type ReviewIssue = { id: string; identifier: string; title: string }
export type ReviewDetail = {
  branch: string
  baseBranch: string
  checks: "passed" | "pending" | "failed"
  people: Array<ReviewPerson>
  issues: Array<ReviewIssue>
  files: Array<ReviewFile>
  commits: Array<{
    sha: string
    title: string
    author: string
    createdAt: string
  }>
}
export function fileStats(file: ReviewFile) {
  return {
    additions: file.lines.filter((line) => line.kind === "add").length,
    deletions: file.lines.filter((line) => line.kind === "remove").length,
  }
}
export function reviewStats(files: Array<ReviewFile>) {
  return files.reduce(
    (total, file) => {
      const counts = fileStats(file)
      return {
        additions: total.additions + counts.additions,
        deletions: total.deletions + counts.deletions,
      }
    },
    { additions: 0, deletions: 0 }
  )
}
const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.string(),
  createdAt: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  side: z.enum(["old", "new"]).optional(),
  resolved: z.boolean().default(false),
  attachments: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        data: z.string(),
      })
    )
    .optional(),
})
export type ReviewComment = z.infer<typeof commentSchema>
export const reviewEditSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  descriptionDoc: z.record(z.string(), z.unknown()).optional(),
  reactions: z
    .array(z.object({ emoji: z.string(), users: z.array(z.string()) }))
    .default([]),
  attachments: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        data: z.string(),
      })
    )
    .default([]),
  status: z.enum(["open", "draft", "merged", "closed"]).optional(),
  reviewState: z
    .enum(["requested", "changes-requested", "approved", "reviewed"])
    .optional(),
  closedAt: z.string().nullable().optional(),
  favorite: z.boolean().default(false),
  reviewerIds: z.array(z.string()).optional(),
  issueIds: z.array(z.string()).default([]),
  reviewedPaths: z.array(z.string()).default([]),
  comments: z.array(commentSchema).default([]),
  activity: z
    .array(
      z.object({
        id: z.string(),
        body: z.string(),
        createdAt: z.string(),
        status: z.enum(["open", "draft", "merged", "closed"]).optional(),
        actor: z.string().optional(),
      })
    )
    .default([]),
})
export type ReviewEdit = z.infer<typeof reviewEditSchema>
export const emptyReviewEdit = (): ReviewEdit => reviewEditSchema.parse({})
export function reviewEditsKey(scope: { workspaceId: string; userId: string }) {
  return `forge:reviews-preview:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`
}
export function readReviewEdits(key: string): Record<string, ReviewEdit> {
  try {
    const result = z
      .record(z.string(), reviewEditSchema)
      .safeParse(JSON.parse(localStorage.getItem(key) ?? "{}"))
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}
export function applyReviewEdit(
  review: Review,
  edit: ReviewEdit | undefined
): Review {
  if (!edit) return review
  return {
    ...review,
    title: edit.title ?? review.title,
    description: edit.description ?? review.description,
    descriptionDoc: edit.descriptionDoc ?? review.descriptionDoc,
    status: edit.status ?? review.status,
    reviewState: edit.reviewState ?? review.reviewState,
    reviewerIds: edit.reviewerIds ?? review.reviewerIds,
    closedAt: edit.closedAt === undefined ? review.closedAt : edit.closedAt,
  }
}
export type ReviewSearch = {
  review?: string
  tab?: "overview" | "diff"
  file?: string
}
export function validateReviewSearch(
  search: Record<string, unknown>
): ReviewSearch {
  return {
    ...(typeof search.review === "string" ? { review: search.review } : {}),
    ...(search.tab === "diff" ? { tab: "diff" as const } : {}),
    ...(typeof search.file === "string" ? { file: search.file } : {}),
  }
}
