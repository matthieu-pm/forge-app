import { z } from "zod"

export const issueFileCommandSchema = z
  .object({
    commandKey: z.uuid(),
    teamId: z.uuid(),
    issueId: z.uuid(),
    action: z.enum(["attach", "detach"]),
    fileIds: z
      .array(z.uuid())
      .min(1)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
    commentId: z.uuid().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict()
export type IssueFileCommand = z.infer<typeof issueFileCommandSchema>
export const browserIssueFileSchema = issueFileCommandSchema.extend({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
