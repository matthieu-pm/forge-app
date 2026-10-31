import "@tanstack/react-start/server-only"
import { and, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { readIssueRows, requireIssueTeam } from "./issues.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { IssueEngagementCommand } from "@/lib/issue-engagement-contract"
import { db, issues } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { readableIssueCondition } from "@/application/resource-policy.server"
import {
  issueEngagementCommandSchema,
  issueSubscriberIds,
  normalizeReactionEmoji,
} from "@/lib/issue-engagement-contract"
import { withoutUndefined } from "@/lib/canonical-json"

class EngagementRejected extends Error {}
async function requireEngagementIssue(
  tx: Transaction,
  actor: Actor,
  input: IssueEngagementCommand
) {
  await requireIssueTeam(tx, actor, input.teamId)
  const row = (
    await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.teamId, input.teamId),
          isNull(issues.archivedAt),
          readableIssueCondition(actor, issues.id)
        )
      )
  )[0]
  if (!row) throw new ApplicationAccessError()
  return row
}
let allowedEmoji: Promise<Set<string>> | undefined
function emojiChoices() {
  return (allowedEmoji ??= import("emojibase-data/en/compact.json").then(
    ({ default: data }) =>
      new Set(
        data
          .flatMap((item) => [
            item.unicode,
            ...(item.skins?.map((skin) => skin.unicode) ?? []),
          ])
          .map(normalizeReactionEmoji)
      )
  ))
}

export async function commandIssueEngagement(
  actor: Actor,
  raw: IssueEngagementCommand
) {
  const input = issueEngagementCommandSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "issues.engagement@1",
      input: withoutUndefined(input),
      status: 200,
      parse: (value) => z.object({ issueId: z.uuid() }).strict().parse(value),
      authorize: async (tx, current) => {
        await requireEngagementIssue(tx, current, input)
      },
      run: async (tx, current) => {
        // Same graph/row lock order as discussion and lifecycle commands. Never
        // replace a snapshot supplied by the client or require a whole-issue revision.
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
        )[0]
        await requireEngagementIssue(tx, current, input)
        const properties = { ...row.properties }
        let changed = false
        if (input.action === "subscription") {
          const ids = issueSubscriberIds(properties.subscribers ?? "")
          changed = ids.includes(current.userId) !== input.subscribed
          properties.subscribers = (
            input.subscribed
              ? [...new Set([...ids, current.userId])]
              : ids.filter((id) => id !== current.userId)
          ).join(", ")
        } else {
          if (!(await emojiChoices()).has(input.emoji))
            throw new EngagementRejected(
              "Choose an emoji from the reaction picker."
            )
          const comment = input.commentId
            ? properties.comments?.find((c) => c.id === input.commentId)
            : undefined
          if (input.commentId && (!comment || comment.deleted))
            throw new EngagementRejected(
              "This comment is no longer available for reactions."
            )
          const target = comment ?? properties
          const previous = target.reactions ?? []
          const users = new Set(
            previous
              .filter((r) => normalizeReactionEmoji(r.emoji) === input.emoji)
              .flatMap((r) => r.users)
          )
          changed = users.has(current.userId) !== input.present
          if (input.present) users.add(current.userId)
          else users.delete(current.userId)
          const reactions = previous.filter(
            (r) => normalizeReactionEmoji(r.emoji) !== input.emoji
          )
          if (users.size)
            reactions.push({ emoji: input.emoji, users: [...users].sort() })
          if (reactions.length > 100)
            throw new EngagementRejected(
              "This discussion already has 100 different reactions."
            )
          if (comment)
            properties.comments = properties.comments.map((c) =>
              c.id === comment.id ? { ...c, reactions } : c
            )
          else properties.reactions = reactions
        }
        // New desired-state commands can also be no-ops. They get a receipt but
        // do not bump the issue revision or publish duplicate activity.
        if (changed)
          await tx
            .update(issues)
            .set({ properties })
            .where(eq(issues.id, row.id))
        return {
          value: { issueId: row.id },
          resource: { type: "issue", id: row.id },
          events: changed
            ? [
                {
                  topic:
                    input.action === "subscription"
                      ? "issue.subscription.changed"
                      : "issue.reaction.changed",
                  payload: {
                    issueId: row.id,
                    teamId: row.teamId,
                    actorId: current.userId,
                    ...(input.action === "subscription"
                      ? { subscribed: input.subscribed }
                      : {
                          ...(input.commentId
                            ? { commentId: input.commentId }
                            : {}),
                          emoji: input.emoji,
                          present: input.present,
                        }),
                  },
                },
              ]
            : [],
        }
      },
    })
    const records = await db.transaction(async (tx) =>
      readIssueRows(tx, await currentCommandActor(tx, actor), [input.issueId])
    )
    return { status: "saved" as const, replayed: result.replayed, records }
  } catch (error) {
    if (error instanceof EngagementRejected)
      return {
        status: "rejected" as const,
        message: error.message,
        records: [],
      }
    throw error
  }
}
