import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Transaction } from "@/db"
import type { Actor } from "@/application/actor"
import type { IssueHistoryPage } from "@/lib/issue-history-contract"
import { db, issues } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import {
  readableIssueCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import {
  boundedHistoryText,
  issueHistoryEnvelopeSchema,
  issueHistoryQuerySchema,
} from "@/lib/issue-history-contract"

const cursorSchema = z
  .object({
    version: z.literal(1),
    binding: z.string().length(64),
    time: z
      .string()
      .max(80)
      .refine((s) => Number.isFinite(Date.parse(s))),
    id: z.uuid(),
  })
  .strict()

async function requireHistoryIssue(
  tx: Transaction,
  actor: Actor,
  issueId: string
) {
  const issue = (
    await tx
      .select({ id: issues.id, legacyId: issues.legacyId })
      .from(issues)
      .where(
        and(eq(issues.id, issueId), readableIssueCondition(actor, issues.id))
      )
  ).at(0)
  if (!issue) throw new ApplicationAccessError()
  return issue
}

export async function queryIssueHistory(
  actor: Actor,
  raw: z.input<typeof issueHistoryQuerySchema>
): Promise<IssueHistoryPage> {
  const input = issueHistoryQuerySchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    requireResourceScope(current, "issues:read")
    const issue = await requireHistoryIssue(tx, current, input.issueId)
    const binding = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: current.workspaceId,
          userId: current.userId,
          authentication: current.authentication,
          issueId: input.issueId,
        })
      )
      .digest("hex")
    let cursor: z.infer<typeof cursorSchema> | undefined
    if (input.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))
        )
      } catch {
        throw new Error("Invalid history cursor. Refresh history.")
      }
      if (cursor.binding !== binding)
        throw new Error("This history cursor belongs to another view.")
    }
    // Exact PostgreSQL microseconds remain in the cursor, never round through JS Date.
    // Audit join proves attribution; receipt join limits this view to completed commands.
    const result = await tx.execute(sql`
      SELECT e.id, e.topic, e.created_at::text AS time, e.payload,
        a.actor_user_id, coalesce(u.name, 'Former member') AS actor_name
      FROM command_outbox_events e
      JOIN command_audit_events a ON a.command_id=e.command_id AND a.workspace_id=e.workspace_id
      JOIN command_receipts r ON r.id=e.command_id AND r.workspace_id=e.workspace_id AND r.completed_at IS NOT NULL
      LEFT JOIN "user" u ON u.id=a.actor_user_id
      WHERE e.workspace_id=${current.workspaceId} AND e.payload->>'issueId'=${input.issueId}
        AND ${readableIssueCondition(current, sql`${input.issueId}::uuid`)}
        AND e.topic LIKE 'issue.%' AND e.topic <> 'issue.comment.mentioned'
        ${cursor ? sql`AND (e.created_at,e.id) < (${cursor.time}::timestamptz,${cursor.id}::uuid)` : sql``}
      ORDER BY e.created_at DESC,e.id DESC LIMIT ${input.limit + 1}
    `)
    const rows = result.rows as Array<{
      id: string
      topic: string
      time: string
      payload: Record<string, unknown>
      actor_user_id: string
      actor_name: string
    }>
    // A denied data read must fail rather than look like an empty older page:
    // the client clears protected entries on failure instead of merging stale rows.
    if (!rows.length) await requireHistoryIssue(tx, current, input.issueId)
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      entries: page.map((row) => {
        const details = issueHistoryEnvelopeSchema.safeParse(
          row.payload.history
        )
        const trusted =
          details.success && details.data.actor.userId === row.actor_user_id
        return {
          id: row.id,
          topic: row.topic,
          createdAt: new Date(row.time).toISOString(),
          actor: {
            userId: row.actor_user_id,
            name: trusted
              ? details.data.actor.name
              : boundedHistoryText(row.actor_name, 200),
            kind: trusted ? details.data.actor.kind : "unknown",
          },
          origin: trusted
            ? details.data.origin
            : row.topic === "issue.created" && issue.legacyId
              ? "import"
              : "command",
          changes: trusted ? details.data.changes : [],
          ...(typeof row.payload.commentId === "string" &&
          z.uuid().safeParse(row.payload.commentId).success
            ? { commentId: row.payload.commentId }
            : {}),
        }
      }),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                binding,
                time: last.time,
                id: last.id,
              })
            ).toString("base64url")
          : null,
    }
  })
}
