import "@tanstack/react-start/server-only"
import { randomUUID } from "node:crypto"
import { and, eq, isNull, lte, or, sql } from "drizzle-orm"
import {
  assertUploadPolicy,
  authorizeUploadTarget,
} from "./upload-authorization.server"
import type { Actor } from "@/application/actor"
import type {
  ReadyUpload,
  UploadInput,
} from "@/application/files/upload-contract"
import type {
  UploadIntent,
  UploadStore,
  VerifiedUpload,
} from "@/application/files/upload-store"
import type { Transaction } from "@/db"
import {
  agentAttachments,
  db,
  fileUploadIntents as intents,
  resourceFiles,
} from "@/db"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { commandInputHash } from "@/application/commands/command-input"
import {
  UPLOAD_LIMITS,
  UploadError,
  readyUploadSchema,
} from "@/application/files/upload-contract"
import { createAgentAttachmentInputSchema } from "@/application/agents/attachment-contract"
import { ApplicationAccessError } from "@/application/authorization"
import { executeCommand } from "@/application/commands/execute-command.server"

async function lockCapacity(tx: Transaction, actor: Actor) {
  // Account scope spans workspaces. Fixed order prevents admission deadlocks.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"upload-account:" + actor.userId}, 0))`
  )
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"upload-workspace:" + actor.workspaceId}, 0))`
  )
}
async function owned(tx: Transaction, actor: Actor, id: string) {
  const [row] = await tx
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.id, id),
        eq(intents.workspaceId, actor.workspaceId),
        eq(intents.userId, actor.userId)
      )
    )
    .for("update")
  if (!row) throw new ApplicationAccessError("Upload not found.")
  return row
}
function pending(row: UploadIntent, now: Date) {
  if (row.state !== "pending" || row.expiresAt <= now)
    throw new UploadError(
      "INVALID_UPLOAD",
      row.expiresAt <= now
        ? "This upload has expired. Start a new upload."
        : "This upload was refused or cancelled. Start a new upload."
    )
}
export class DrizzleUploadStore implements UploadStore {
  constructor(private readonly now = () => new Date()) {}
  async create(actor: Actor, input: UploadInput): Promise<UploadIntent> {
    return db.transaction(async (tx) => {
      actor = await currentCommandActor(tx, actor)
      await lockCapacity(tx, actor)
      await authorizeUploadTarget(tx, actor, input.target)
      const hash = commandInputHash(input)
      const [existing] = await tx
        .select()
        .from(intents)
        .where(
          and(
            eq(intents.workspaceId, actor.workspaceId),
            eq(intents.userId, actor.userId),
            eq(intents.commandKey, input.commandKey)
          )
        )
      if (existing) {
        if (existing.inputHash !== hash)
          throw new UploadError(
            "UPLOAD_CONFLICT",
            "This upload key was already used with different input."
          )
        return existing
      }
      const now = this.now()
      await assertUploadPolicy(
        tx,
        actor,
        input.sizeBytes,
        input.contentType,
        now
      )
      // Includes old still-pending reservations as well as this hour's completions.
      const usage = await tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE state='pending' AND expires_at > ${now} AND user_id=${actor.userId})::int AS account_pending,
          count(*) FILTER (WHERE state='pending' AND expires_at > ${now} AND workspace_id=${actor.workspaceId})::int AS workspace_pending,
          coalesce(sum(size_bytes) FILTER (WHERE user_id=${actor.userId} AND ((state='pending' AND expires_at > ${now}) OR (state='ready' AND completed_at > ${new Date(now.getTime() - 3_600_000)}))),0)::bigint AS account_bytes,
          coalesce(sum(size_bytes) FILTER (WHERE workspace_id=${actor.workspaceId} AND ((state='pending' AND expires_at > ${now}) OR (state='ready' AND completed_at > ${new Date(now.getTime() - 3_600_000)}))),0)::bigint AS workspace_bytes
        FROM file_upload_intents WHERE (user_id=${actor.userId} OR workspace_id=${actor.workspaceId}) AND ((state='pending' AND expires_at > ${now}) OR (state='ready' AND completed_at > ${new Date(now.getTime() - 3_600_000)}))`)
      const counts = usage.rows[0] as {
        account_pending: number
        workspace_pending: number
        account_bytes: string
        workspace_bytes: string
      }
      if (
        counts.account_pending >= UPLOAD_LIMITS.accountPending ||
        counts.workspace_pending >= UPLOAD_LIMITS.workspacePending
      )
        throw new UploadError(
          "UPLOAD_LIMIT",
          "Too many unfinished uploads. Finish or cancel an upload before starting another.",
          60
        )
      if (
        Number(counts.account_bytes) + input.sizeBytes >
          UPLOAD_LIMITS.accountHourlyBytes ||
        Number(counts.workspace_bytes) + input.sizeBytes >
          UPLOAD_LIMITS.workspaceHourlyBytes
      )
        throw new UploadError(
          "UPLOAD_LIMIT",
          "The hourly upload byte allowance is reserved or used. Retry after capacity becomes available.",
          3600
        )
      const [row] = await tx
        .insert(intents)
        .values({
          ...input,
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          inputHash: hash,
          storageReference: `files/${randomUUID()}`,
          createdAt: now,
          expiresAt: new Date(now.getTime() + UPLOAD_LIMITS.lifetimeMs),
        })
        .returning()
      return row
    })
  }
  async prepare(
    actor: Actor,
    id: string,
    issueToken = false
  ): Promise<UploadIntent> {
    return db.transaction(async (tx) => {
      actor = await currentCommandActor(tx, actor)
      const row = await owned(tx, actor, id)
      await authorizeUploadTarget(tx, actor, row.target)
      if (row.state === "ready") return row
      const now = this.now()
      pending(row, now)
      await assertUploadPolicy(tx, actor, row.sizeBytes, row.contentType, now)
      if (!issueToken) return row
      const attempts = row.attempts.filter(
        (at) => at > now.getTime() - 3_600_000
      )
      if (attempts.length >= UPLOAD_LIMITS.attemptsPerHour)
        throw new UploadError(
          "UPLOAD_LIMIT",
          "This upload has reached five attempts in one hour. Retry later without extending its expiry.",
          Math.max(
            1,
            Math.ceil((attempts[0] + 3_600_000 - now.getTime()) / 1000)
          )
        )
      const [updated] = await tx
        .update(intents)
        .set({
          attempts: [...attempts, now.getTime()],
          tokenExpiresAt: new Date(
            Math.min(
              row.expiresAt.getTime(),
              now.getTime() + UPLOAD_LIMITS.tokenMs
            )
          ),
        })
        .where(eq(intents.id, id))
        .returning()
      return updated
    })
  }
  async publish(
    actor: Actor,
    id: string,
    verified: VerifiedUpload
  ): Promise<ReadyUpload> {
    const command = await executeCommand({
      actor,
      commandKey: id,
      operation: "files.upload.finalize",
      input: { id },
      status: 201,
      parse: (value) => readyUploadSchema.parse(value),
      authorize: async (tx, current) => {
        const row = await owned(tx, current, id)
        await authorizeUploadTarget(tx, current, row.target)
      },
      run: async (tx, actor) => {
        const row = await owned(tx, actor, id)
        if (row.result)
          throw new UploadError(
            "UPLOAD_CONFLICT",
            "Ready upload is missing its command receipt."
          )
        const now = this.now()
        pending(row, now)
        if (
          verified.checksum !== row.checksum ||
          verified.sizeBytes !== row.sizeBytes
        )
          throw new UploadError(
            "INVALID_UPLOAD",
            "The stored file does not match the upload intent."
          )
        await assertUploadPolicy(
          tx,
          actor,
          verified.sizeBytes,
          verified.contentType,
          now
        )
        const result: ReadyUpload = {
          id: row.id,
          name: row.name,
          ...verified,
          createdAt: now.toISOString(),
          expiresAt:
            row.target.kind === "agent"
              ? new Date(now.getTime() + 24 * 3_600_000).toISOString()
              : null,
        }
        if (row.target.kind === "agent") {
          if (
            !createAgentAttachmentInputSchema
              .omit({ contentBase64: true })
              .safeParse({ name: row.name, contentType: verified.contentType })
              .success
          )
            throw new UploadError(
              "INVALID_UPLOAD",
              "This file format is not supported by the agent composer."
            )
          await tx.insert(agentAttachments).values({
            id,
            name: row.name,
            ...verified,
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            storageReference: row.storageReference,
            createdAt: now,
            expiresAt: new Date(result.expiresAt!),
          })
        } else {
          await tx.insert(resourceFiles).values({
            id,
            name: row.name,
            ...verified,
            workspaceId: actor.workspaceId,
            createdByUserId: actor.userId,
            storageReference: row.storageReference,
            createdAt: now,
            issueId: row.target.kind === "issue" ? row.target.id : null,
            documentId: row.target.kind === "document" ? row.target.id : null,
          })
        }
        await tx
          .update(intents)
          .set({ state: "ready", result, completedAt: now })
          .where(eq(intents.id, id))
        return {
          value: result,
          resource: { type: "file", id },
          events: [
            {
              topic: "file.ready",
              payload: { fileId: id, target: row.target },
            },
          ],
        }
      },
    })
    return command.value
  }
  async reject(actor: Actor, id: string, reason: string) {
    await db
      .update(intents)
      .set({ state: "rejected", rejectionReason: reason.slice(0, 500) })
      .where(
        and(
          eq(intents.id, id),
          eq(intents.workspaceId, actor.workspaceId),
          eq(intents.userId, actor.userId),
          eq(intents.state, "pending")
        )
      )
  }
  async cleanupCandidates(before: Date, limit: number) {
    // Atomically make expired pending intents unpublishable before selecting bytes.
    await db
      .update(intents)
      .set({ state: "expired", rejectionReason: "Upload expired." })
      .where(and(eq(intents.state, "pending"), lte(intents.expiresAt, before)))
    return db
      .select()
      .from(intents)
      .where(
        and(
          or(eq(intents.state, "rejected"), eq(intents.state, "expired")),
          or(
            isNull(intents.cleanedAt),
            lte(intents.cleanedAt, new Date(before.getTime() - 3_600_000))
          ),
          or(
            isNull(intents.tokenExpiresAt),
            lte(
              intents.tokenExpiresAt,
              new Date(before.getTime() - 15 * 60_000)
            )
          )
        )
      )
      .orderBy(sql`${intents.cleanedAt} ASC NULLS FIRST`, intents.createdAt)
      .limit(limit)
  }
  async markCleaned(id: string) {
    await db
      .update(intents)
      .set({ cleanedAt: this.now() })
      .where(
        and(
          eq(intents.id, id),
          or(eq(intents.state, "rejected"), eq(intents.state, "expired"))
        )
      )
  }
}
