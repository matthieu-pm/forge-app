import "@tanstack/react-start/server-only"
import { and, eq, ilike, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { readIssueRows, requireIssueTeam } from "./issues.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { IssueCommentCommand } from "@/lib/issue-comment-contract"
import { db, issues, members, teamMembers, teams, users } from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  readableIssueCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { issueCommentCommandSchema } from "@/lib/issue-comment-contract"
import {
  commentMentionIds,
  commentPlainText,
  resolveCommentMentions,
  validateCommentDocument,
} from "@/lib/comment-rich-text"
import { withoutUndefined } from "@/lib/canonical-json"

class CommentConflict extends Error {}
class CommentInputError extends Error {}
async function requireCommentIssue(
  tx: Transaction,
  actor: Actor,
  issueId: string,
  teamId?: string
) {
  requireResourceScope(actor, "issues:read")
  const row = (
    await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.id, issueId),
          teamId ? eq(issues.teamId, teamId) : undefined,
          readableIssueCondition(actor, issues.id)
        )
      )
  )[0]
  if (!row) throw new ApplicationAccessError()
  return row
}
async function eligibleMentions(
  tx: Transaction,
  actor: Actor,
  issueId: string,
  ids?: Array<string>,
  query = ""
) {
  // The recipient is evaluated with its own live member/team access, never the sender's role.
  return tx
    .select({ id: users.id, name: sql<string>`left(${users.name}, 200)` })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, actor.workspaceId),
        readableIssueCondition(
          { workspaceId: actor.workspaceId, userId: members.userId },
          sql`${issueId}::uuid`
        ),
        ids
          ? inArray(users.id, ids)
          : ilike(users.name, `%${query.replace(/[\\%_]/g, "\\$&")}%`)
      )
    )
    .orderBy(users.name, users.id)
    .limit(ids ? 100 : 30)
}

export async function queryCommentMentions(
  actor: Actor,
  issueId: string,
  query: string
) {
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    await requireCommentIssue(tx, current, issueId)
    return {
      targets: await eligibleMentions(tx, current, issueId, undefined, query),
      canModerate: hasWorkspaceRole(current, ["owner", "admin"]),
    }
  })
}

export async function commandIssueComment(
  actor: Actor,
  raw: IssueCommentCommand
) {
  const input = issueCommentCommandSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "issues.comment@1",
      input: withoutUndefined(input),
      status: 200,
      parse: (value) =>
        z
          .object({ issueId: z.uuid(), commentId: z.uuid() })
          .strict()
          .parse(value),
      authorize: async (tx, current) => {
        await requireIssueTeam(tx, current, input.teamId)
        await requireCommentIssue(tx, current, input.issueId, input.teamId)
      },
      run: async (tx, current) => {
        // Follow lifecycle's graph lock order so delete/archive/purge cannot race publication.
        await tx.execute(
          sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
        )
        await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, input.teamId))
          .for("share")
        // Lock eligibility rows for the duration of commit, including private-team revocations.
        await tx
          .select({ id: members.id })
          .from(members)
          .where(eq(members.organizationId, current.workspaceId))
          .for("share")
        await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, input.teamId))
          .for("share")
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
        await requireCommentIssue(tx, current, input.issueId, input.teamId)
        const comments = [...(row.properties.comments ?? [])],
          index = comments.findIndex((c) => c.id === input.commentId),
          before = comments[index]
        if (input.action === "create" ? Boolean(before) : !before)
          throw new CommentInputError(
            "This comment is unavailable or you cannot change it."
          )
        if (
          before &&
          before.author !== current.userId &&
          !hasWorkspaceRole(current, ["owner", "admin"])
        )
          throw new CommentInputError(
            "This comment is unavailable or you cannot change it."
          )
        if (before && (before.version ?? 0) !== input.expectedVersion)
          throw new CommentConflict()
        if (before?.deleted && input.action === "edit")
          throw new CommentConflict()
        if (
          before &&
          ((input.action === "delete" && before.deleted) ||
            (input.action === "restore" && !before.deleted))
        )
          throw new CommentConflict()
        if (input.parentId) {
          const parent = comments.find((c) => c.id === input.parentId)
          if (!parent || parent.parentId || parent.deleted)
            throw new CommentInputError(
              "This thread is no longer available for replies."
            )
        }
        const now = new Date().toISOString()
        const authorName =
          (
            await tx
              .select({ name: users.name })
              .from(users)
              .where(eq(users.id, current.userId))
          )[0]?.name.slice(0, 200) ?? "Member"
        let document = input.document
        const ids = document ? commentMentionIds(document) : []
        if (ids.length > 50)
          throw new CommentInputError("Mention up to 50 people per comment.")
        if (document) {
          const eligible = ids.length
            ? await eligibleMentions(tx, current, input.issueId, ids)
            : []
          if (eligible.length !== ids.length)
            throw new CommentInputError(
              "One or more mentions are unavailable. Choose people with current issue access."
            )
          document = resolveCommentMentions(
            document,
            new Map(eligible.map((p) => [p.id, p.name]))
          )
          // Labels resolved by the server still obey the text limit.
          try {
            document = validateCommentDocument(document)
          } catch (error) {
            throw new CommentInputError(
              error instanceof Error
                ? error.message
                : "Invalid comment content."
            )
          }
        }
        const comment =
          input.action === "create"
            ? {
                id: input.commentId,
                parentId: input.parentId,
                attachmentId: "",
                resolved: false,
                author: current.userId,
                authorName,
                body: commentPlainText(document!),
                document: document! as unknown as Record<string, unknown>,
                version: 0,
                createdAt: now,
                edited: false,
                deleted: false,
                attachments: [],
                reactions: [],
              }
            : {
                ...before,
                version: (before.version ?? 0) + 1,
                ...(input.action === "edit"
                  ? {
                      document: document! as unknown as Record<string, unknown>,
                      body: commentPlainText(document!),
                      edited: true,
                      editedAt: now,
                      editedBy: current.userId,
                      editedByName: authorName,
                    }
                  : {
                      deleted: input.action === "delete",
                      deletedAt: input.action === "delete" ? now : null,
                      deletedBy:
                        input.action === "delete" ? current.userId : null,
                    }),
              }
        if (index < 0) comments.push(comment)
        else comments[index] = comment
        await tx
          .update(issues)
          .set({ properties: { ...row.properties, comments } })
          .where(eq(issues.id, row.id))
        let previousIds: Array<string> = []
        try {
          previousIds = commentMentionIds(
            validateCommentDocument(before?.document)
          )
        } catch {
          /* Legacy plain text has no structured mentions. */
        }
        const event = {
          issueId: row.id,
          teamId: input.teamId,
          commentId: comment.id,
          authorId: comment.author,
          actorId: current.userId,
          version: comment.version,
        }
        return {
          value: { issueId: row.id, commentId: comment.id },
          resource: { type: "issue", id: row.id },
          events: [
            {
              topic: `issue.comment.${{ create: "created", edit: "edited", delete: "deleted", restore: "restored" }[input.action]}`,
              payload: event,
            },
            ...ids
              .filter((id) => !previousIds.includes(id))
              .map((recipientId) => ({
                topic: "issue.comment.mentioned",
                payload: { ...event, recipientId },
              })),
          ],
        }
      },
    })
    const records = await db.transaction(async (tx) =>
      readIssueRows(tx, await currentCommandActor(tx, actor), [input.issueId])
    )
    return { status: "saved" as const, replayed: result.replayed, records }
  } catch (error) {
    // Only an error thrown INSIDE run proves this exact command rolled back.
    // Authorization can fail before receipt lookup or after a committed write;
    // those uncertain outcomes must retain the original retry identity.
    if (error instanceof CommentInputError)
      return {
        status: "rejected" as const,
        message: error.message,
        records: [],
      }
    if (!(error instanceof CommentConflict)) throw error
    const records = await db.transaction(async (tx) =>
      readIssueRows(tx, await currentCommandActor(tx, actor), [input.issueId])
    )
    return { status: "conflict" as const, records }
  }
}
