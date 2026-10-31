import { z } from "zod"

/** Keep UTF-16 schema bounds without splitting a supplementary character into
 * an unpaired surrogate, which PostgreSQL correctly refuses in JSONB. */
export function boundedHistoryText(value: string, limit: number) {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "")
}

/** Versioned, body-free envelope in the existing committed outbox. Producers may
 * add new topics without inventing actors or a parallel audit writer. */
export const issueHistoryDetailsSchema = z
  .object({
    version: z.literal(1),
    origin: z.enum(["command", "import"]).default("command"),
    changes: z
      .array(
        z
          .object({
            field: z.string().max(100),
            from: z.string().max(1000),
            to: z.string().max(1000),
          })
          .strict()
      )
      .max(50)
      .default([]),
  })
  .strict()
export const issueHistoryEnvelopeSchema = issueHistoryDetailsSchema.extend({
  actor: z
    .object({
      userId: z.string().min(1),
      name: z.string().max(200),
      kind: z.enum(["session", "apiKey", "agent"]),
    })
    .strict(),
})
export type IssueHistoryDetails = z.input<typeof issueHistoryDetailsSchema>
export const issueHistoryQuerySchema = z
  .object({
    issueId: z.uuid(),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z.string().max(4096).optional(),
  })
  .strict()
export const browserIssueHistoryQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    query: issueHistoryQuerySchema,
  })
  .strict()
export type IssueHistoryEntry = {
  id: string
  topic: string
  createdAt: string
  actor: {
    userId: string
    name: string
    kind: "session" | "apiKey" | "agent" | "unknown"
  }
  origin: "command" | "import"
  changes: Array<{ field: string; from: string; to: string }>
  commentId?: string
}
export type IssueHistoryPage = {
  entries: Array<IssueHistoryEntry>
  nextCursor: string | null
}
