import "@tanstack/react-start/server-only"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { readIssueRows, requireIssueTeam } from "./issues.server"
import { relationshipErrorMessage } from "./relationship-errors"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { IssueDraft } from "@/lib/issue-record-contract"
import type {
  ChangeIssueRelationship,
  IssueRelationshipPage,
  RelationshipIssue,
} from "@/lib/issue-relationship-contract"
import { db, issueRelations, issues, organizations, teams } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  readableIssueCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import {
  changeRelationshipSchema,
  relationshipLabels,
  relationshipQuerySchema,
  relationshipSearchSchema,
} from "@/lib/issue-relationship-contract"

const summary = {
  id: issues.id,
  title: issues.title,
  revision: issues.revision,
  teamId: issues.teamId,
  teamSlug: teams.slug,
  identifier: teams.identifier,
  number: issues.number,
}

class RelationshipConflict extends Error {}

/** One receipt commits the relationship, endpoint revisions, history and events. */
export async function changeIssueRelationship(
  actor: Actor,
  raw: ChangeIssueRelationship
) {
  const input = changeRelationshipSchema.parse(raw)
  const ids = [input.issueId, input.targetId]
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "issues.relationship@1",
      input,
      status: 200,
      parse: (value) =>
        z
          .object({ issueIds: z.array(z.uuid()) })
          .strict()
          .parse(value),
      authorize: async (tx, current, value) => {
        await visibleEndpoints(tx, current, value?.issueIds ?? ids, true)
      },
      run: async (tx, current) => {
        // Match canonical create/edit lock order before taking graph or issue locks.
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, current.workspaceId))
          .for("no key update")
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.workspaceId},4040))`
        )
        await tx.execute(
          sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
        )
        await visibleEndpoints(tx, current, ids, true)
        const rows = await tx
          .select()
          .from(issues)
          .where(
            and(
              inArray(issues.id, ids),
              eq(issues.workspaceId, current.workspaceId)
            )
          )
          .orderBy(issues.id)
          .for("update")
        const source = rows.find((r) => r.id === input.issueId)!,
          target = rows.find((r) => r.id === input.targetId)!
        if (
          source.revision !== input.expectedRevision ||
          target.revision !== input.expectedTargetRevision
        )
          throw new RelationshipConflict()
        const affected = [...rows]
        let oldParentId: string | null = null
        let changed = false
        if (input.kind === "parent" || input.kind === "child") {
          const child = input.kind === "parent" ? source : target
          const parent = input.kind === "parent" ? target : source
          if (input.action === "add" && child.parentId !== parent.id) {
            if (child.parentId) {
              await visibleEndpoints(tx, current, [child.parentId], true)
              const [oldParent] = await tx
                .select()
                .from(issues)
                .where(eq(issues.id, child.parentId))
                .for("update")
              affected.push(oldParent)
              oldParentId = oldParent.id
            }
            await tx
              .update(issues)
              .set({ parentId: parent.id })
              .where(eq(issues.id, child.id))
            changed = true
          } else if (
            input.action === "remove" &&
            child.parentId === parent.id
          ) {
            await tx
              .update(issues)
              .set({ parentId: null })
              .where(eq(issues.id, child.id))
            changed = true
          }
        } else {
          let from = source.id,
            to = target.id
          if (
            input.kind === "blockedBy" ||
            (input.kind === "related" && from > to)
          )
            [from, to] = [to, from]
          const kind = input.kind === "related" ? "related" : "blocks"
          // Remove legacy reverse copies as well; new related links use sorted IDs.
          const pair =
            kind === "related"
              ? sql`((${issueRelations.issueId}=${from} AND ${issueRelations.relatedIssueId}=${to}) OR (${issueRelations.issueId}=${to} AND ${issueRelations.relatedIssueId}=${from}))`
              : and(
                  eq(issueRelations.issueId, from),
                  eq(issueRelations.relatedIssueId, to)
                )!
          const condition = and(
            eq(issueRelations.workspaceId, current.workspaceId),
            eq(issueRelations.kind, kind),
            pair
          )
          if (input.action === "remove") {
            changed =
              (
                await tx
                  .delete(issueRelations)
                  .where(condition)
                  .returning({ id: issueRelations.id })
              ).length > 0
          } else if (
            !(
              await tx
                .select({ id: issueRelations.id })
                .from(issueRelations)
                .where(condition)
            )[0]
          ) {
            await tx.insert(issueRelations).values({
              workspaceId: current.workspaceId,
              issueId: from,
              relatedIssueId: to,
              kind,
            })
            changed = true
          }
        }
        if (changed) {
          const now = new Date().toISOString()
          for (const row of affected) {
            // Canonical columns predate full draft JSON; legacy rows may omit history.
            const properties: Partial<IssueDraft> = row.properties
            const inverse = {
              parent: "child",
              child: "parent",
              related: "related",
              blocks: "blockedBy",
              blockedBy: "blocks",
            } as const
            const kind =
              row.id === oldParentId
                ? "child"
                : row.id === source.id
                  ? input.kind
                  : inverse[input.kind]
            const action = row.id === oldParentId ? "remove" : input.action
            await tx
              .update(issues)
              .set({
                properties: {
                  ...row.properties,
                  activity: [
                    ...(properties.activity ?? []),
                    {
                      id: crypto.randomUUID(),
                      author: current.userId,
                      createdAt: now,
                      text: `${action === "add" ? "added" : "removed"} ${relationshipLabels[kind].toLowerCase()} relationship`,
                    },
                  ],
                },
              })
              .where(eq(issues.id, row.id))
          }
        }
        return {
          value: { issueIds: affected.map((r) => r.id) },
          resource: { type: "issue", id: source.id },
          events: changed
            ? affected.map((r) => ({
                topic: "issue.relationship-changed",
                payload: { issueId: r.id, teamId: r.teamId },
              }))
            : [],
        }
      },
    })
    const records = await db.transaction(async (tx) =>
      readIssueRows(
        tx,
        await currentCommandActor(tx, actor),
        result.value.issueIds
      )
    )
    return { status: "saved" as const, replayed: result.replayed, records }
  } catch (error) {
    if (error instanceof RelationshipConflict) {
      const records = await db.transaction(async (tx) => {
        const current = await currentCommandActor(tx, actor)
        await visibleEndpoints(tx, current, ids)
        return readIssueRows(tx, current, ids)
      })
      return { status: "conflict" as const, records }
    }
    const message = relationshipErrorMessage(error)
    if (message) return { status: "invalid" as const, message }
    throw error
  }
}
async function visibleEndpoints(
  tx: Transaction,
  actor: Actor,
  ids: Array<string>,
  write = false
) {
  requireResourceScope(actor, "issues:read")
  if (write) requireResourceScope(actor, "issues:write")
  const rows = await tx
    .select(summary)
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(
      and(
        inArray(issues.id, ids),
        eq(issues.workspaceId, actor.workspaceId),
        isNull(issues.archivedAt),
        readableIssueCondition(actor, issues.id)
      )
    )
  if (rows.length !== new Set(ids).size) throw new ApplicationAccessError()
  if (write)
    for (const teamId of new Set(rows.map((r) => r.teamId)))
      await requireIssueTeam(tx, actor, teamId)
  return rows
}

/** Bounded reciprocal reads authorize endpoints before pagination. */
export async function readIssueRelationships(
  actor: Actor,
  raw: z.input<typeof relationshipQuerySchema>
): Promise<IssueRelationshipPage> {
  const input = relationshipQuerySchema.parse(raw)
  return db.transaction(
    async (tx) => {
      const current = await currentCommandActor(tx, actor)
      const [issue] = await visibleEndpoints(tx, current, [input.issueId])
      const result = await tx.execute(sql`
      WITH edges(kind,target_id) AS (
        SELECT 'parent', parent_id FROM issues WHERE id=${input.issueId} AND workspace_id=${current.workspaceId} AND parent_id IS NOT NULL
        UNION SELECT 'child', id FROM issues WHERE parent_id=${input.issueId} AND workspace_id=${current.workspaceId}
        UNION SELECT kind, related_issue_id FROM issue_relations WHERE issue_id=${input.issueId} AND workspace_id=${current.workspaceId} AND kind IN ('related','blocks')
        UNION SELECT CASE WHEN kind='blocks' THEN 'blockedBy' ELSE kind END, issue_id FROM issue_relations WHERE related_issue_id=${input.issueId} AND workspace_id=${current.workspaceId} AND kind IN ('related','blocks')
      )
      SELECT e.kind, i.id,i.title,i.revision,i.team_id AS "teamId",t.slug AS "teamSlug",t.identifier,i.number
      FROM edges e JOIN issues i ON i.id=e.target_id JOIN teams t ON t.id=i.team_id
      WHERE i.workspace_id=${current.workspaceId} AND i.archived_at IS NULL AND ${readableIssueCondition(current, sql`i.id`)}
        AND (e.kind || ':' || i.id::text) COLLATE "C" > ${input.cursor ?? ""} COLLATE "C"
      ORDER BY (e.kind || ':' || i.id::text) COLLATE "C" LIMIT ${input.limit + 1}
    `)
      const rows = result.rows as Array<
        RelationshipIssue & {
          kind: IssueRelationshipPage["relationships"][number]["kind"]
        }
      >
      const page = rows.slice(0, input.limit)
      return {
        issue,
        relationships: page.map(({ kind, ...target }) => ({
          kind,
          issue: target,
        })),
        nextCursor:
          rows.length > input.limit
            ? `${page.at(-1)!.kind}:${page.at(-1)!.id}`
            : null,
      }
    },
    { isolationLevel: "repeatable read" }
  )
}

export async function searchRelationshipIssues(
  actor: Actor,
  raw: z.input<typeof relationshipSearchSchema>
) {
  const input = relationshipSearchSchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    await visibleEndpoints(tx, current, [input.issueId])
    const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`
    const rows = await tx
      .select(summary)
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(
        and(
          eq(issues.workspaceId, current.workspaceId),
          isNull(issues.archivedAt),
          readableIssueCondition(current, issues.id),
          sql`${issues.id}<>${input.issueId}`,
          input.after ? sql`${issues.id}>${input.after}` : undefined,
          sql`(${issues.title} ILIKE ${pattern} OR (${teams.identifier} || '-' || ${issues.number}::text) ILIKE ${pattern})`
        )
      )
      .orderBy(issues.id)
      .limit(21)
    return {
      issues: rows.slice(0, 20),
      nextCursor: rows.length > 20 ? rows[19].id : null,
    }
  })
}
