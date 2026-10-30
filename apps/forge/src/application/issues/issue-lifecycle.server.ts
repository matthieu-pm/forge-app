import "@tanstack/react-start/server-only"
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { requireIssueTeam } from "./issues.server"
import type { Actor } from "@/application/actor"
import type {
  InactiveIssuePage,
  IssueLifecycleInput,
} from "@/lib/issue-lifecycle-contract"
import {
  inactiveIssuesSchema,
  issueLifecycleSchema,
} from "@/lib/issue-lifecycle-contract"
import { db, issues, organizations } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { readableIssueCondition } from "@/application/resource-policy.server"

class LifecycleConflict extends Error {}
export async function changeIssueLifecycle(
  actor: Actor,
  raw: IssueLifecycleInput
) {
  const input = issueLifecycleSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "issues.lifecycle@1",
      input,
      status: 200,
      parse: (value) =>
        z
          .object({
            issueId: z.uuid(),
            revision: z.number().int().nonnegative(),
          })
          .strict()
          .parse(value),
      authorize: async (tx, current) => {
        await requireIssueTeam(tx, current, input.teamId)
        const row = (
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.id, input.issueId),
                eq(issues.teamId, input.teamId),
                readableIssueCondition(current, issues.id, true)
              )
            )
        ).at(0)
        if (!row) throw new ApplicationAccessError()
      },
      run: async (tx, current) => {
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
        const row = (
          await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.id, input.issueId),
                eq(issues.workspaceId, current.workspaceId)
              )
            )
            .for("update")
        ).at(0)
        if (!row || row.purgedAt) throw new ApplicationAccessError()
        if (row.revision !== input.expectedRevision)
          throw new LifecycleConflict()
        if (row.deletedAt && input.action !== "restore")
          throw new Error("Restore this issue before changing it.")
        if (!row.deletedAt && input.action === "restore")
          throw new Error("This issue is not deleted.")
        const now = new Date()
        if (
          input.action === "restore" &&
          (row.purgeStartedAt ||
            row.deletedAt!.getTime() + 30 * 86400000 <= now.getTime())
        )
          throw new Error("The issue recovery period has ended.")
        const updated = (
          await tx
            .update(issues)
            .set({
              ...(input.action === "delete" ? { deletedAt: now } : {}),
              ...(input.action === "restore" ? { deletedAt: null } : {}),
              ...(input.action === "archive"
                ? { archivedAt: row.archivedAt ?? now }
                : {}),
              ...(input.action === "unarchive" ? { archivedAt: null } : {}),
              properties: {
                ...row.properties,
                activity: [
                  ...(Array.isArray(row.properties.activity)
                    ? row.properties.activity
                    : []),
                  {
                    id: crypto.randomUUID(),
                    author: current.userId,
                    text: {
                      delete: "deleted the issue",
                      restore: "restored the issue",
                      archive: "archived the issue",
                      unarchive: "unarchived the issue",
                    }[input.action],
                    createdAt: now.toISOString(),
                  },
                ],
              },
            })
            .where(eq(issues.id, row.id))
            .returning({ revision: issues.revision })
        ).at(0)
        if (!updated) throw new Error("The issue could not be changed.")
        return {
          value: { issueId: row.id, revision: updated.revision },
          resource: { type: "issue", id: row.id },
          events: [
            {
              topic: `issue.${input.action}`,
              payload: { issueId: row.id, teamId: input.teamId },
            },
          ],
        }
      },
    })
    return { status: "saved" as const, ...result }
  } catch (error) {
    if (error instanceof LifecycleConflict)
      return { status: "conflict" as const }
    // Drizzle wraps constraint errors. Do not expose SQL or parameters.
    let cause: unknown = error
    for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
      const nested = cause as Error & { constraint?: string; cause?: unknown }
      if (nested.constraint === "workspace_active_issue_limit")
        throw new Error(
          "This workspace has reached 250 active issues. Archive an issue or upgrade, then retry."
        )
      if (nested.constraint === "issue_recovery_expired")
        throw new Error("The issue recovery period has ended.")
      cause = nested.cause
    }
    if (error instanceof Error && "cause" in error)
      throw new Error("The issue could not be changed. Reload and try again.")
    throw error
  }
}

export async function listInactiveIssues(
  actor: Actor,
  raw: z.input<typeof inactiveIssuesSchema>
): Promise<InactiveIssuePage> {
  const input = inactiveIssuesSchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    await requireIssueTeam(tx, current, input.teamId)
    const rows = await tx
      .select({
        id: issues.id,
        title: issues.title,
        number: issues.number,
        revision: issues.revision,
        archivedAt: issues.archivedAt,
        deletedAt: issues.deletedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.teamId, input.teamId),
          readableIssueCondition(current, issues.id, true),
          input.kind === "deleted"
            ? and(
                isNotNull(issues.deletedAt),
                isNull(issues.purgeStartedAt),
                sql`${issues.deletedAt} + interval '720 hours' > clock_timestamp()`
              )
            : and(isNull(issues.deletedAt), isNotNull(issues.archivedAt)),
          input.after ? gt(issues.id, input.after) : undefined
        )
      )
      .orderBy(asc(issues.id))
      .limit(51)
    return {
      items: rows.slice(0, 50).map((r) => ({
        ...r,
        archivedAt: r.archivedAt?.toISOString() ?? null,
        deletedAt: r.deletedAt?.toISOString() ?? null,
        recoverUntil: r.deletedAt
          ? new Date(r.deletedAt.getTime() + 30 * 86400000).toISOString()
          : null,
      })),
      nextCursor: rows.length > 50 ? rows[49].id : null,
    }
  })
}
