import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import type { SharedInboxPage } from "@/lib/shared-inbox-contract"
import { db } from "@/db"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import {
  readableIssueCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { readIssueRows } from "@/application/issues/issues.server"
import { defaultDefinitionValue } from "@/lib/issue-definition-contract"

const cursorSchema = z
  .object({
    binding: z.string(),
    time: z.string().datetime(),
    issueId: z.uuid(),
    commandId: z.uuid(),
  })
  .strict()
const messages: Record<string, string> = {
  assignment: "Assigned this issue to you.",
  mention: "Mentioned you in a comment.",
  comment: "Updated the discussion.",
  reply: "Replied to the discussion.",
  status: "Changed the issue status.",
  update: "Updated this issue.",
  reaction: "Reacted to the discussion.",
}
const sqlArray = (values: Array<string>) =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  )}]`

export async function queryInbox(
  actor: Actor,
  cursor?: string
): Promise<SharedInboxPage> {
  return db.transaction(
    async (tx) => {
      const current = await currentCommandActor(tx, actor)
      requireResourceScope(current, "issues:read")
      const sessionId =
        current.authentication.kind === "session"
          ? current.authentication.sessionId
          : ""
      const binding = createHash("sha256")
        .update(
          JSON.stringify([
            current.workspaceId,
            current.userId,
            current.authentication,
          ])
        )
        .digest("hex")
      let before: z.infer<typeof cursorSchema> | undefined
      if (cursor) {
        before = cursorSchema.parse(
          JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
        )
        if (before.binding !== binding)
          throw new Error("The inbox cursor belongs to another session.")
      }
      const rows = (
        await tx.execute(sql`
      SELECT n.issue_id,n.command_id,n.kind,e.payload,a.actor_user_id,coalesce(u.name,'Former member') actor_name,
        to_char(n.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at
      FROM inbox_activity n
      JOIN command_outbox_events e ON e.id=n.event_id AND e.workspace_id=n.workspace_id
      JOIN command_audit_events a ON a.command_id=n.command_id AND a.workspace_id=n.workspace_id
      LEFT JOIN "user" u ON u.id=a.actor_user_id
      WHERE n.workspace_id=${current.workspaceId} AND n.user_id=${current.userId}
        AND ${readableIssueCondition(current, sql`n.issue_id`)}
        AND (e.payload->>'commentId' IS NULL OR EXISTS (
          SELECT 1 FROM issues i,jsonb_array_elements(coalesce(i.properties->'comments','[]'::jsonb)) c
          WHERE i.id=n.issue_id AND c->>'id'=e.payload->>'commentId' AND coalesce(c->>'deleted','false')<>'true'
        ))
        ${before ? sql`AND (n.occurred_at,n.issue_id,n.command_id)<(${before.time}::timestamptz,${before.issueId}::uuid,${before.commandId}::uuid)` : sql``}
      ORDER BY n.occurred_at DESC,n.issue_id DESC,n.command_id DESC LIMIT 101
    `)
      ).rows as Array<{
        issue_id: string
        command_id: string
        kind: SharedInboxPage["entries"][number]["events"][number]["kind"]
        payload: { commentId?: string }
        actor_user_id: string
        actor_name: string
        occurred_at: string
      }>
      const page = rows.slice(0, 100)
      const ids = [...new Set(page.map((r) => r.issue_id))]
      const records = ids.length ? await readIssueRows(tx, current, ids) : []
      const teamIds = [...new Set(records.map((r) => r.teamId))]
      const assigneeIds = [
        ...new Set(
          records
            .map((r) => r.issue.assignee)
            .filter((id): id is string => !!id)
        ),
      ]
      const projectIds = [
        ...new Set(
          records.map((r) => r.issue.project).filter((id): id is string => !!id)
        ),
      ]
      const definitions = (
        await tx.execute(
          sql`SELECT team_id,value FROM issue_definition_scopes WHERE workspace_id=${current.workspaceId} AND team_id=ANY(${sqlArray(teamIds)}::uuid[])`
        )
      ).rows as Array<{
        team_id: string
        value: ReturnType<typeof defaultDefinitionValue>
      }>
      const teamRows = (
        await tx.execute(
          sql`SELECT id,identifier FROM teams WHERE workspace_id=${current.workspaceId} AND id=ANY(${sqlArray(teamIds)}::uuid[])`
        )
      ).rows as Array<{ id: string; identifier: string }>
      const people = (
        await tx.execute(
          sql`SELECT u.id,u.name FROM "user" u JOIN member m ON m.user_id=u.id WHERE m.organization_id=${current.workspaceId} AND u.id=ANY(${sqlArray(assigneeIds)}::text[])`
        )
      ).rows as Array<{ id: string; name: string }>
      const projects = (
        await tx.execute(
          sql`SELECT id,name FROM projects WHERE workspace_id=${current.workspaceId} AND id=ANY(${sqlArray(projectIds)}::uuid[])`
        )
      ).rows as Array<{ id: string; name: string }>
      const groups = new Map<string, SharedInboxPage["entries"][number]>()
      for (const row of page) {
        const record = records.find((r) => r.issue.id === row.issue_id)
        if (!record) continue
        const issue = record.issue
        const workflow =
          definitions.find((d) => d.team_id === record.teamId)?.value ??
          defaultDefinitionValue()
        const status = workflow.statuses.statuses.find(
          (s) => s.id === issue.status
        )
        let entry = groups.get(row.issue_id)
        if (!entry) {
          entry = {
            id: `issue:${issue.id}`,
            issue: {
              id: issue.id,
              identifier: `${teamRows.find((t) => t.id === record.teamId)?.identifier ?? "ISSUE"}-${issue.number}`,
              title: issue.title,
              description: issue.description,
              status: status?.name ?? issue.status,
              statusType: status?.group,
              priority: issue.priority,
              assignee:
                people.find((p) => p.id === issue.assignee)?.name ?? null,
              project:
                projects.find((p) => p.id === issue.project)?.name ?? null,
            },
            events: [],
          }
          groups.set(row.issue_id, entry)
        }
        const comment = issue.comments.find(
          (c) => c.id === row.payload.commentId && !c.deleted
        )
        entry.events.unshift({
          id: `${row.command_id}:${row.issue_id}`,
          kind: row.kind,
          actor: row.actor_name,
          actorId: row.actor_user_id,
          createdAt: row.occurred_at,
          message: comment?.body ?? messages[row.kind],
        })
      }
      const last = page.at(-1)
      return {
        workspaceId: current.workspaceId,
        userId: current.userId,
        sessionId,
        entries: [...groups.values()],
        nextCursor:
          rows.length > 100 && last
            ? Buffer.from(
                JSON.stringify({
                  binding,
                  time: last.occurred_at,
                  issueId: last.issue_id,
                  commandId: last.command_id,
                })
              ).toString("base64url")
            : null,
      }
    },
    { isolationLevel: "repeatable read" }
  )
}
