import { z } from "zod"
import { triageDraftSchema } from "./triage-record-contract"

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
    creationKey: z.string().min(1).max(255).optional(),
    creationIndex: z.number().int().min(0).max(4).optional(),
  })
  .strict()
export type IssueFileCommand = z.infer<typeof issueFileCommandSchema>
export const browserIssueFileSchema = issueFileCommandSchema.extend({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})

export const creationFileJobSchema = z
  .object({
    issueId: z.uuid(),
    teamId: z.uuid(),
    creationKey: z.string().min(1).max(255),
    files: triageDraftSchema.shape.attachments.unwrap(),
    next: z.number().int().nonnegative().default(0),
    completed: z.boolean().default(false),
    attempts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    sessions: z
      .array(
        z.tuple([
          z.string(),
          z.object({ commandKey: z.string(), id: z.string().optional() }),
        ])
      )
      .default([]),
    command: issueFileCommandSchema.optional(),
  })
  .strict()
export type CreationFileJob = z.infer<typeof creationFileJobSchema>
export const creationFileJobKey = (issueId: string) =>
  `forge:file-draft:v1:${issueId}:creation`
