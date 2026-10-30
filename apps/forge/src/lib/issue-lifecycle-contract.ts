import { z } from "zod"

export const issueLifecycleSchema = z
  .object({
    commandKey: z.uuid(),
    teamId: z.uuid(),
    issueId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    action: z.enum(["delete", "restore", "archive", "unarchive"]),
  })
  .strict()
export type IssueLifecycleInput = z.infer<typeof issueLifecycleSchema>
export const browserIssueLifecycleSchema = issueLifecycleSchema.extend({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
export const inactiveIssuesSchema = z
  .object({
    teamId: z.uuid(),
    kind: z.enum(["deleted", "archived"]),
    after: z.uuid().optional(),
  })
  .strict()
export const browserInactiveIssuesSchema = inactiveIssuesSchema.extend({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
export type InactiveIssue = {
  id: string
  title: string
  number: number
  revision: number
  archivedAt: string | null
  deletedAt: string | null
  recoverUntil: string | null
}
export type InactiveIssuePage = {
  items: Array<InactiveIssue>
  nextCursor: string | null
}
