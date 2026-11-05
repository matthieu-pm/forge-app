import { z } from "zod"

export const inboxEventKinds = [
  "assignment",
  "mention",
  "comment",
  "status",
  "reply",
  "update",
  "reaction",
] as const
export const inboxEventSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(inboxEventKinds),
  actor: z.string(),
  actorId: z.string(),
  createdAt: z.string().datetime(),
  message: z.string(),
})
export const inboxIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
  description: z.string(),
  status: z.string(),
  statusType: z
    .enum([
      "triage",
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
      "duplicate",
    ])
    .optional(),
  priority: z.string(),
  assignee: z.string().nullable(),
  project: z.string().nullable(),
})
export const sharedInboxQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    cursor: z.string().max(4096).optional(),
  })
  .strict()
export const sharedInboxPageSchema = sharedInboxQuerySchema.extend({
  userId: z.string().min(1),
  entries: z.array(
    z.object({
      id: z.string(),
      issue: inboxIssueSchema.extend({
        revision: z.number().int().nonnegative(),
      }),
      deliveryRevision: z.string().regex(/^[0-9]+$/),
      events: z.array(inboxEventSchema),
    })
  ),
  nextCursor: z.string().nullable(),
})
export type SharedInboxPage = z.infer<typeof sharedInboxPageSchema>
