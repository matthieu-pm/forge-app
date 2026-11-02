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
import {
  agentApprovals,
  agentArtifacts,
  agentEvents,
  agentRuns,
  commandOutboxEvents,
} from "@/db/schema"
import { loopArtifactIntents, loopEvents, loopRuns } from "@/db/loops-schema"
import { LOOP_ARTIFACT_INTENT_LEASE_MS } from "@/lib/loop-artifact-intent-policy"
import { organizations } from "@/db/auth-schema"

/** Source-bound copies are drained in bounded groups. The committed source
 * purge marker plus SQL callback fences prevent a late worker from refilling
 * a completed group. Every byte reference survives until its delete succeeds. */
async function purgeLoopCopies(
  database: Omit<typeof DefaultDatabase, "$client">,
  target: { id: string; workspaceId: string },
  blobs: Pick<FileBlobStore, "delete">
) {
  const source = and(
    eq(loopRuns.workspaceId, target.workspaceId),
    sql`${loopRuns.event}->>'entity'='issue' AND ${loopRuns.event}->>'entityId'=${target.id}`
  )
  const ownedRuns = database
    .select({ id: loopRuns.agentRunId })
    .from(loopRuns)
    .where(source)
  const ownedLoopRuns = database
    .select({ id: loopRuns.id })
    .from(loopRuns)
    .where(source)
  const rawEvents = await database
    .select({ id: loopEvents.id })
    .from(loopEvents)
    .where(
      and(
        eq(loopEvents.workspaceId, target.workspaceId),
        eq(loopEvents.entity, "issue"),
        eq(loopEvents.entityId, target.id)
      )
    )
    .orderBy(loopEvents.id)
    .limit(100)
  if (rawEvents.length)
    await database.delete(loopEvents).where(
      inArray(
        loopEvents.id,
        rawEvents.map((row) => row.id)
      )
    )
  const dirtyRuns = await database
    .select({ id: loopRuns.id })
    .from(loopRuns)
    .where(
      and(
        source,
        sql`(${loopRuns.state}<>'cancelled' OR ${loopRuns.errorCode} IS DISTINCT FROM 'SOURCE_PURGED' OR ${loopRuns.result} IS NOT NULL OR ${loopRuns.pendingDecision} IS NOT NULL OR ${loopRuns.event}<>jsonb_build_object('entity','issue','entityId',${target.id}::text))`
      )
    )
    .orderBy(loopRuns.id)
    .limit(25)
  if (dirtyRuns.length)
    await database
      .update(loopRuns)
      .set({
        state: "cancelled",
        errorCode: "SOURCE_PURGED",
        result: null,
        pendingDecision: null,
        event: { entity: "issue", entityId: target.id },
        finishedAt: new Date(),
        leaseAt: null,
      })
      .where(
        inArray(
          loopRuns.id,
          dirtyRuns.map((row) => row.id)
        )
      )
  const agents = await database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.id, ownedRuns),
        sql`(${agentRuns.state}<>'cancelled' OR ${agentRuns.errorCode} IS DISTINCT FROM 'SOURCE_PURGED')`
      )
    )
    .orderBy(agentRuns.id)
    .limit(100)
  if (agents.length)
    await database
      .update(agentRuns)
      .set({
        state: "cancelled",
        errorCode: "SOURCE_PURGED",
        completedAt: new Date(),
      })
      .where(
        inArray(
          agentRuns.id,
          agents.map((row) => row.id)
        )
      )
  const payloads = await database
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(
      and(
        inArray(agentEvents.runId, ownedRuns),
        sql`${agentEvents.payloadJson}<>'{}'::jsonb`
      )
    )
    .orderBy(agentEvents.id)
    .limit(100)
  if (payloads.length)
    await database
      .update(agentEvents)
      .set({ payloadJson: {} })
      .where(
        inArray(
          agentEvents.id,
          payloads.map((row) => row.id)
        )
      )
  const approvals = await database
    .select({ id: agentApprovals.id })
    .from(agentApprovals)
    .where(
      and(
        inArray(agentApprovals.runId, ownedRuns),
        sql`(${agentApprovals.redactedInputSummary}<>'{}'::jsonb OR ${agentApprovals.state} IN ('pending','approved'))`
      )
    )
    .orderBy(agentApprovals.id)
    .limit(100)
  if (approvals.length)
    await database
      .update(agentApprovals)
      .set({
        redactedInputSummary: {},
        state: sql`CASE WHEN ${agentApprovals.state} IN ('pending','approved') THEN 'expired' ELSE ${agentApprovals.state} END`,
        resolvedAt: sql`CASE WHEN ${agentApprovals.state} IN ('pending','approved') THEN coalesce(${agentApprovals.resolvedAt},clock_timestamp()) ELSE ${agentApprovals.resolvedAt} END`,
      })
      .where(
        inArray(
          agentApprovals.id,
          approvals.map((row) => row.id)
        )
      )
  const artifacts = await database
    .select({
      id: agentArtifacts.id,
      reference: agentArtifacts.storageReference,
    })
    .from(agentArtifacts)
    .where(inArray(agentArtifacts.runId, ownedRuns))
    .orderBy(agentArtifacts.id)
    .limit(100)
  for (const row of artifacts) {
    await blobs.delete(row.reference)
    await database
      .delete(agentArtifacts)
      .where(
        and(
          eq(agentArtifacts.id, row.id),
          inArray(agentArtifacts.runId, ownedRuns)
        )
      )
  }
  const reservations = await database
    .select({
      id: loopArtifactIntents.id,
      reference: loopArtifactIntents.storageReference,
      ready: sql<boolean>`${loopArtifactIntents.createdAt}+(${LOOP_ARTIFACT_INTENT_LEASE_MS} * interval '1 millisecond')<=clock_timestamp()`,
    })
    .from(loopArtifactIntents)
    .where(
      and(
        eq(loopArtifactIntents.workspaceId, target.workspaceId),
        inArray(loopArtifactIntents.loopRunId, ownedLoopRuns)
      )
    )
    .orderBy(loopArtifactIntents.createdAt, loopArtifactIntents.id)
    .limit(100)
  for (const row of reservations) {
    if (!row.ready) continue
    await blobs.delete(row.reference)
    await database
      .delete(loopArtifactIntents)
      .where(
        and(
          eq(loopArtifactIntents.id, row.id),
          eq(loopArtifactIntents.storageReference, row.reference)
        )
      )
  }
  return {
    pending:
      rawEvents.length === 100 ||
      artifacts.length === 100 ||
      reservations.length === 100 ||
      reservations.some((row) => !row.ready) ||
      dirtyRuns.length === 25 ||
      agents.length === 100 ||
      payloads.length === 100 ||
      approvals.length === 100,
  }
}

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
      const loopCopies = await purgeLoopCopies(database, target, blobs)
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
        if (
          files.length === 100 ||
          intents.length === 100 ||
          loopCopies.pending
        ) {
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
        // History snapshots follow the owning content's recovery deadline. Keep
        // only the separate minimal audit/receipt evidence after permanent purge.
        const history = await tx
          .select({ id: commandOutboxEvents.id })
          .from(commandOutboxEvents)
          .where(
            and(
              eq(commandOutboxEvents.workspaceId, target.workspaceId),
              sql`${commandOutboxEvents.payload}->>'issueId'=${target.id}`
            )
          )
          .limit(100)
        if (history.length)
          await tx.delete(commandOutboxEvents).where(
            inArray(
              commandOutboxEvents.id,
              history.map((e) => e.id)
            )
          )
        if (history.length === 100) {
          await tx
            .update(issues)
            .set({ purgeLeaseUntil: null, purgeToken: null })
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
