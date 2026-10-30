import "@tanstack/react-start/server-only"
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import {
  filterIssueCopy,
  issueCopyPrefixes,
} from "../product-state/issue-copies"
import type { FileBlobStore } from "@/application/files/blob-store"
import type { db as DefaultDatabase } from "@/db"
import {
  documents,
  fileUploadIntents,
  issueLabels,
  issueRelations,
  issues,
  productState,
  resourceFiles,
} from "@/db/planning-schema"
import { organizations } from "@/db/auth-schema"

/** Bounded, leased SQL checkpoints surround idempotent byte deletes. Restore
 * closes at the deadline, independently of worker availability. A failure keeps
 * the owning tombstone and every unfinished storage reference for the retry. */
export async function purgeDeletedIssues(
  blobs: Pick<FileBlobStore, "delete">,
  limit = 25,
  executor?: Omit<typeof DefaultDatabase, "$client">
) {
  const database = executor ?? (await import("@/db")).db
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid purge batch size.")
  const due = await database
    .select({ id: issues.id, workspaceId: issues.workspaceId })
    .from(issues)
    .where(
      and(
        sql`${issues.deletedAt} + interval '720 hours' <= clock_timestamp()`,
        isNull(issues.purgedAt),
        sql`(${issues.purgeLeaseUntil} IS NULL OR ${issues.purgeLeaseUntil} < clock_timestamp())`
      )
    )
    .orderBy(issues.deletedAt, issues.id)
    .limit(limit)
  let purged = 0,
    failed = 0
  for (const target of due) {
    const token = crypto.randomUUID()
    const claimed = await database.transaction(async (tx) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, target.workspaceId))
        .for("no key update")
      return (
        await tx
          .update(issues)
          .set({
            purgeStartedAt: sql`coalesce(${issues.purgeStartedAt},clock_timestamp())`,
            purgeLeaseUntil: sql`clock_timestamp()+interval '10 minutes'`,
            purgeToken: token,
            purgeAttempts: sql`${issues.purgeAttempts}+1`,
            purgeError: null,
          })
          .where(
            and(
              eq(issues.id, target.id),
              isNull(issues.purgedAt),
              sql`${issues.deletedAt} + interval '720 hours' <= clock_timestamp()`,
              sql`(${issues.purgeLeaseUntil} IS NULL OR ${issues.purgeLeaseUntil}<clock_timestamp())`
            )
          )
          .returning({ id: issues.id })
      ).at(0)
    })
    if (!claimed) continue
    try {
      // Shared documents survive through their independent workspace grant.
      const ownedDocs = database
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, target.workspaceId),
            eq(documents.issueId, target.id),
            eq(documents.sharedWithWorkspace, false)
          )
        )
      const fileCondition = and(
        eq(resourceFiles.workspaceId, target.workspaceId),
        or(
          eq(resourceFiles.issueId, target.id),
          inArray(resourceFiles.documentId, ownedDocs)
        )
      )
      const files = await database
        .select()
        .from(resourceFiles)
        .where(fileCondition)
        .limit(100)
      for (const file of files) {
        await blobs.delete(file.storageReference)
        await database
          .delete(resourceFiles)
          .where(
            and(
              eq(resourceFiles.id, file.id),
              eq(resourceFiles.workspaceId, target.workspaceId)
            )
          )
      }
      // Unpublished bytes also belong to the deleted resource. Publication is
      // already fenced by the live resource predicate and its row lock.
      const intents = await database
        .select()
        .from(fileUploadIntents)
        .where(
          and(
            eq(fileUploadIntents.workspaceId, target.workspaceId),
            or(
              sql`${fileUploadIntents.target}->>'kind'='issue' AND ${fileUploadIntents.target}->>'id'=${target.id}`,
              sql`${fileUploadIntents.target}->>'kind'='document' AND ${fileUploadIntents.target}->>'id' IN (SELECT id::text FROM documents WHERE issue_id=${target.id} AND workspace_id=${target.workspaceId} AND NOT shared_with_workspace)`
            )
          )
        )
        .limit(100)
      for (const intent of intents) {
        await blobs.delete(intent.storageReference)
        await database
          .delete(fileUploadIntents)
          .where(eq(fileUploadIntents.id, intent.id))
      }
      const completed = await database.transaction(async (tx) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, target.workspaceId))
          .for("no key update")
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${target.workspaceId},4040))`
        )
        await tx.execute(
          sql`SELECT public.forge_lock_issue_graph(${target.workspaceId})`
        )
        const row = (
          await tx
            .select()
            .from(issues)
            .where(and(eq(issues.id, target.id), eq(issues.purgeToken, token)))
            .for("update")
        ).at(0)
        if (!row) return
        // A large resource is drained across batches without dropping its owner.
        if (files.length === 100 || intents.length === 100) {
          await tx
            .update(issues)
            .set({ purgeLeaseUntil: null, purgeToken: null })
            .where(eq(issues.id, target.id))
          return
        }
        // Keyset checkpoint is atomic with each bounded group of copy writes.
        // Copy writers take the same workspace fence and suppress inactive IDs,
        // so a stale save cannot refill already-scanned rows or cursor holes.
        const copies = await tx
          .select()
          .from(productState)
          .where(
            and(
              eq(productState.workspaceId, target.workspaceId),
              or(
                ...issueCopyPrefixes.map(
                  (prefix) => sql`${productState.key} LIKE ${prefix + "%"}`
                )
              ),
              row.purgeCopyCursor
                ? gt(productState.id, row.purgeCopyCursor)
                : undefined
            )
          )
          .orderBy(productState.id)
          .limit(5)
          .for("update")
        for (const copy of copies) {
          if (copy.encodedValue === null) continue
          let value: string | null
          try {
            value = filterIssueCopy(
              copy.key,
              JSON.parse(copy.encodedValue) as string | null,
              (id) => id !== target.id
            )
          } catch {
            // Unsupported unrelated local state cannot stall every purge in the
            // workspace. Related malformed copies are discarded; normal reads
            // already quarantine all malformed known copy protocols.
            if (
              !copy.encodedValue.toLowerCase().includes(target.id.toLowerCase())
            )
              continue
            value = null
          }
          const encoded = value === null ? null : JSON.stringify(value)
          if (encoded !== copy.encodedValue)
            await tx
              .update(productState)
              .set({ encodedValue: encoded, revision: copy.revision + 1 })
              .where(eq(productState.id, copy.id))
        }
        if (copies.length === 5) {
          await tx
            .update(issues)
            .set({
              purgeCopyCursor: copies[4].id,
              purgeLeaseUntil: null,
              purgeToken: null,
            })
            .where(eq(issues.id, target.id))
          return
        }
        await tx
          .delete(documents)
          .where(
            and(
              eq(documents.issueId, target.id),
              eq(documents.sharedWithWorkspace, false)
            )
          )
        await tx
          .delete(issueRelations)
          .where(
            and(
              eq(issueRelations.workspaceId, target.workspaceId),
              or(
                eq(issueRelations.issueId, target.id),
                eq(issueRelations.relatedIssueId, target.id)
              )
            )
          )
        await tx
          .delete(issueLabels)
          .where(
            and(
              eq(issueLabels.workspaceId, target.workspaceId),
              eq(issueLabels.issueId, target.id)
            )
          )
        await tx
          .update(issues)
          .set({ parentId: null })
          .where(
            and(
              eq(issues.workspaceId, target.workspaceId),
              eq(issues.parentId, target.id)
            )
          )
        await tx
          .update(issues)
          .set({
            title: "",
            properties: sql`'{}'::jsonb`,
            parentId: null,
            projectId: null,
            cycleId: null,
            assigneeId: null,
            creatorId: null,
            purgedAt: sql`clock_timestamp()`,
            purgeLeaseUntil: null,
            purgeToken: null,
            purgeError: null,
          })
          .where(eq(issues.id, target.id))
        return true
      })
      if (completed) purged++
    } catch {
      failed++
      // Never persist provider errors that might contain private URLs/credentials.
      await database
        .update(issues)
        .set({
          purgeError: "Issue purge failed; retry pending.",
          purgeLeaseUntil: sql`clock_timestamp()+interval '5 minutes'`,
          purgeToken: null,
        })
        .where(and(eq(issues.id, target.id), eq(issues.purgeToken, token)))
    }
  }
  return { purged, failed }
}
