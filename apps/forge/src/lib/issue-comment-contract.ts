import { z } from "zod"
import { commentDocumentSchema } from "./comment-rich-text"

export const issueCommentCommandSchema = z
  .object({
    commandKey: z.uuid(),
    teamId: z.uuid(),
    issueId: z.uuid(),
    action: z.enum(["create", "edit", "delete", "restore"]),
    commentId: z.uuid(),
    parentId: z.union([z.uuid(), z.literal("")]).default(""),
    expectedVersion: z.number().int().nonnegative().default(0),
    document: commentDocumentSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (["create", "edit"].includes(v.action) !== Boolean(v.document))
      ctx.addIssue({
        code: "custom",
        message: "Supply content only when creating or editing a comment.",
      })
    if (v.action !== "create" && v.parentId)
      ctx.addIssue({
        code: "custom",
        message: "A comment cannot move between threads.",
      })
  })
export type IssueCommentCommand = z.infer<typeof issueCommentCommandSchema>
export const browserIssueCommentSchema = issueCommentCommandSchema.safeExtend({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
export const mentionQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    issueId: z.uuid(),
    query: z.string().max(100).default(""),
  })
  .strict()
export type MentionTarget = { id: string; name: string }
