import { z } from "zod"
import { initiativeProjectSchema } from "./initiatives"
import { issueDraftSchema } from "./issue-record-contract"

export const issueChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    description: issueDraftSchema.shape.description.optional(),
    descriptionDoc: issueDraftSchema.shape.descriptionDoc
      .removeDefault()
      .optional(),
    status: issueDraftSchema.shape.status.optional(),
    priority: issueDraftSchema.shape.priority.optional(),
    assignee: z.string().max(200).optional(),
    project: z.string().max(200).optional(),
    labels: z.string().max(1000).optional(),
    dueDate: issueDraftSchema.shape.dueDate.optional(),
    cycle: z.union([z.iso.date(), z.literal("")]).optional(),
    parentId: z.union([z.uuid(), z.literal("")]).optional(),
    links: issueDraftSchema.shape.links.removeDefault().max(100).optional(),
    recurrence: issueDraftSchema.shape.recurrence.removeDefault().optional(),
    milestone: issueDraftSchema.shape.milestone.removeDefault().optional(),
    snoozed: z.boolean().optional(),
    subIssues: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  })
  .strict()
export type IssueChanges = z.infer<typeof issueChangesSchema>
export const editIssueBatchSchema = z
  .object({
    commandKey: z.uuid(),
    teamId: z.uuid(),
    edits: z
      .array(
        z
          .object({
            issueId: z.uuid(),
            expectedRevision: z.number().int().nonnegative(),
            changes: issueChangesSchema,
            triageDecision: z.enum(["accept", "decline"]).optional(),
            projectImport: initiativeProjectSchema.optional(),
            cycleImport: z
              .object({ startDate: z.iso.date(), endDate: z.iso.date() })
              .strict()
              .optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.edits.map((e) => e.issueId)).size === input.edits.length,
    "Each issue can appear once in a batch."
  )
export type EditIssueBatch = z.infer<typeof editIssueBatchSchema>
export const browserEditIssueSchema = editIssueBatchSchema.safeExtend({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
