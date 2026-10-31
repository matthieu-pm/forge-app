import "@tanstack/react-start/server-only"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import { readIssueRows, requireIssueTeam } from "./issues.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { IssueFileCommand } from "@/lib/issue-file-contract"
import type { IssueDraft } from "@/lib/issue-record-contract"
import { db, fileUploadIntents, issues, resourceFiles } from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { executeCommand } from "@/application/commands/execute-command.server"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { readableIssueCondition } from "@/application/resource-policy.server"
import { issueFileCommandSchema } from "@/lib/issue-file-contract"
import { withoutUndefined } from "@/lib/canonical-json"

export class IssueFileInputError extends Error {}

/** Called with the owning issue locked; metadata comes only from verified files. */
export async function bindIssueFiles(
  tx: Transaction,
  actor: Actor,
  issueId: string,
  ids: Array<string>,
  existing: NonNullable<IssueDraft["attachments"]>,
  commentId?: string
) {
  if (existing.length + ids.length > 5)
    throw new IssueFileInputError("Attach up to 5 files.")
  if (!ids.length) return existing
  const rows = await tx
    .select({ file: resourceFiles, intent: fileUploadIntents })
    .from(resourceFiles)
    .innerJoin(fileUploadIntents, eq(resourceFiles.id, fileUploadIntents.id))
    .where(
      and(
        inArray(resourceFiles.id, ids),
        eq(resourceFiles.workspaceId, actor.workspaceId),
        eq(resourceFiles.issueId, issueId),
        eq(resourceFiles.createdByUserId, actor.userId),
        or(
          eq(resourceFiles.attachmentState, "unbound"),
          isNull(resourceFiles.attachmentState)
        ),
        isNull(resourceFiles.deletedAt),
        eq(fileUploadIntents.workspaceId, actor.workspaceId),
        eq(fileUploadIntents.userId, actor.userId),
        eq(fileUploadIntents.state, "ready")
      )
    )
    .orderBy(resourceFiles.id)
    .for("update")
  if (
    rows.length !== ids.length ||
    rows.some(
      ({ file, intent }) =>
        intent.target.kind !== "issue" ||
        intent.target.id !== issueId ||
        intent.storageReference !== file.storageReference ||
        intent.checksum !== file.checksum ||
        intent.sizeBytes !== file.sizeBytes ||
        !intent.result ||
        intent.result.checksum !== file.checksum ||
        intent.result.sizeBytes !== file.sizeBytes ||
        intent.result.contentType !== file.contentType
    )
  )
    throw new IssueFileInputError(
      "The upload is unavailable, already attached, or not ready. Upload it again."
    )
  await tx
    .update(resourceFiles)
    .set({ attachmentState: "attached", commentId: commentId ?? null })
    .where(inArray(resourceFiles.id, ids))
  return [
    ...existing,
    ...ids.map((id) => {
      const file = rows.find((r) => r.file.id === id)!.file
      return {
        id,
        fileId: id,
        name: file.name,
        data: "",
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        checksum: file.checksum,
      }
    }),
  ]
}

export async function commandIssueFiles(actor: Actor, raw: IssueFileCommand) {
  const input = issueFileCommandSchema.parse(raw)
  const result = await executeCommand({
    actor,
    commandKey: input.commandKey,
    operation: "issues.files@1",
    input: withoutUndefined(input),
    status: 200,
    parse: (value) => z.object({ issueId: z.uuid() }).strict().parse(value),
    authorize: async (tx, current) => {
      await requireIssueTeam(tx, current, input.teamId)
      const [row] = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.teamId, input.teamId),
            isNull(issues.archivedAt),
            readableIssueCondition(current, issues.id)
          )
        )
      if (!row) throw new ApplicationAccessError()
      if (input.commentId) {
        const comment = row.properties.comments?.find(
          (c) => c.id === input.commentId
        )
        if (
          !comment ||
          comment.deleted ||
          (comment.author !== current.userId &&
            !hasWorkspaceRole(current, ["owner", "admin"]))
        )
          throw new ApplicationAccessError()
      }
    },
    run: async (tx, current) => {
      await tx.execute(
        sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
      )
      const [row] = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.workspaceId, current.workspaceId),
            eq(issues.teamId, input.teamId),
            isNull(issues.archivedAt),
            readableIssueCondition(current, issues.id)
          )
        )
        .for("update")
      if (!row) throw new ApplicationAccessError()
      const comments = [...(row.properties.comments ?? [])]
      const comment = input.commentId
        ? comments.find((c) => c.id === input.commentId)
        : undefined
      if (
        input.commentId &&
        (!comment ||
          comment.deleted ||
          (comment.author !== current.userId &&
            !hasWorkspaceRole(current, ["owner", "admin"])))
      )
        throw new ApplicationAccessError()
      if (comment && (comment.version ?? 0) !== input.expectedVersion)
        throw new IssueFileInputError(
          "This comment changed. Reload before changing its files."
        )
      let attachments = [
        ...((comment ? comment.attachments : row.properties.attachments) ?? []),
      ]
      if (input.action === "attach")
        attachments = await bindIssueFiles(
          tx,
          current,
          row.id,
          input.fileIds,
          attachments,
          input.commentId
        )
      else {
        if (
          input.fileIds.some((id) => !attachments.some((f) => f.fileId === id))
        )
          throw new IssueFileInputError(
            "This file is no longer attached. Reload the issue."
          )
        const detached = await tx
          .update(resourceFiles)
          .set({ attachmentState: "detached" })
          .where(
            and(
              eq(resourceFiles.workspaceId, current.workspaceId),
              eq(resourceFiles.issueId, row.id),
              inArray(resourceFiles.id, input.fileIds),
              eq(resourceFiles.attachmentState, "attached"),
              input.commentId
                ? eq(resourceFiles.commentId, input.commentId)
                : isNull(resourceFiles.commentId)
            )
          )
          .returning({ id: resourceFiles.id })
        if (detached.length !== input.fileIds.length)
          throw new IssueFileInputError(
            "The attachment is unavailable. Reload the issue."
          )
        attachments = attachments.filter(
          (f) => !input.fileIds.includes(f.fileId ?? "")
        )
      }
      if (comment) {
        comments[comments.indexOf(comment)] = {
          ...comment,
          attachments,
          version: (comment.version ?? 0) + 1,
        }
      }
      await tx
        .update(issues)
        .set({
          properties: {
            ...row.properties,
            ...(comment ? { comments } : { attachments }),
          },
        })
        .where(eq(issues.id, row.id))
      return {
        value: { issueId: row.id },
        resource: { type: "issue", id: row.id },
        events: [
          {
            topic: `issue.file.${input.action === "attach" ? "attached" : "detached"}`,
            payload: {
              issueId: row.id,
              fileIds: input.fileIds,
              commentId: input.commentId ?? null,
            },
          },
        ],
      }
    },
  })
  const records = await db.transaction(async (tx) =>
    readIssueRows(tx, await currentCommandActor(tx, actor), [input.issueId])
  )
  return { records, replayed: result.replayed }
}
