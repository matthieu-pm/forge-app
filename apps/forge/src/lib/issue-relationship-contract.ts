import { z } from "zod"

export const issueRelationshipKind = z.enum([
  "parent",
  "child",
  "related",
  "blocks",
  "blockedBy",
])
export type IssueRelationshipKind = z.infer<typeof issueRelationshipKind>
export const relationshipQuerySchema = z
  .object({
    issueId: z.uuid(),
    cursor: z
      .string()
      .regex(/^(parent|child|related|blocks|blockedBy):[0-9a-f-]{36}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
export const changeRelationshipSchema = z
  .object({
    commandKey: z.uuid(),
    issueId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    targetId: z.uuid(),
    expectedTargetRevision: z.number().int().nonnegative(),
    kind: issueRelationshipKind,
    action: z.enum(["add", "remove"]),
  })
  .strict()
  .refine(
    (v) => v.issueId !== v.targetId,
    "An issue cannot be related to itself."
  )
export type ChangeIssueRelationship = z.infer<typeof changeRelationshipSchema>
export type RelationshipIssue = {
  id: string
  title: string
  revision: number
  teamId: string
  teamSlug: string
  identifier: string
  number: number
}
export type IssueRelationshipPage = {
  issue: RelationshipIssue
  relationships: Array<{
    kind: IssueRelationshipKind
    issue: RelationshipIssue
  }>
  nextCursor: string | null
}
export const relationshipLabels: Record<IssueRelationshipKind, string> = {
  parent: "Parent",
  child: "Sub-issue",
  related: "Related to",
  blocks: "Blocks",
  blockedBy: "Blocked by",
}
export const browserRelationshipQuerySchema = relationshipQuerySchema
  .extend({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict()
export const relationshipSearchSchema = z
  .object({
    issueId: z.uuid(),
    search: z.string().trim().max(200).default(""),
    after: z.uuid().optional(),
  })
  .strict()
export const browserRelationshipSearchSchema = relationshipSearchSchema
  .extend({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict()
export const browserChangeRelationshipSchema =
  changeRelationshipSchema.safeExtend({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  })
