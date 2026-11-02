import "@tanstack/react-start/server-only"
import { and, eq, lte, sql } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { StoredAgentArtifactRecord } from "@/application/agents/artifact-store"
import type { AgentArtifactPublication } from "@/application/agents/artifact-service.server"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { agentArtifacts, db, loopArtifactIntents, loopRuns } from "@/db"

import { LOOP_ARTIFACT_INTENT_LEASE_MS } from "@/lib/loop-artifact-intent-policy"

const artifact = (
  row: typeof agentArtifacts.$inferSelect
): StoredAgentArtifactRecord => ({
  ...row,
  kind: row.kind as StoredAgentArtifactRecord["kind"],
})
const intentIdentity = (
  record: Pick<StoredAgentArtifactRecord, "id" | "runId" | "storageReference">
) =>
  and(
    eq(loopArtifactIntents.id, record.id),
    eq(loopArtifactIntents.agentRunId, record.runId),
    eq(loopArtifactIntents.storageReference, record.storageReference)
  )
async function lockSourceBeforePrincipal(
  tx: Transaction,
  actor: Actor,
  record: StoredAgentArtifactRecord
) {
  const scope = actor.loopScope
  if (!scope) throw new ApplicationAccessError()
  const probe = (
    await tx
      .select({ event: loopRuns.event })
      .from(loopRuns)
      .where(
        and(
          eq(loopRuns.id, scope.runId),
          eq(loopRuns.workspaceId, actor.workspaceId),
          eq(loopRuns.agentRunId, record.runId)
        )
      )
  )[0]
  if (!probe) throw new ApplicationAccessError()
  if (probe.event.entity === "issue") {
    const source = await tx.execute(
      sql`SELECT id FROM issues WHERE workspace_id=${actor.workspaceId} AND id::text=${String(probe.event.entityId)} AND deleted_at IS NULL AND purge_started_at IS NULL AND purged_at IS NULL FOR SHARE`
    )
    if (!source.rows.length) throw new ApplicationAccessError()
  }
  return currentCommandActor(tx, actor)
}

// A lost commit response must never delete bytes already owned by published
// metadata. Locking the reservation waits for an in-flight publish transaction.
async function recoverPublication(
  record: Pick<StoredAgentArtifactRecord, "id" | "runId" | "storageReference">
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: loopArtifactIntents.id })
      .from(loopArtifactIntents)
      .where(intentIdentity(record))
      .for("update")
    const row = (
      await tx
        .select()
        .from(agentArtifacts)
        .where(
          and(
            eq(agentArtifacts.id, record.id),
            eq(agentArtifacts.runId, record.runId),
            eq(agentArtifacts.storageReference, record.storageReference)
          )
        )
    )[0]
    return row ? artifact(row) : null
  })
}

export const loopArtifactPublication: AgentArtifactPublication = {
  reserve: async (actor, record) => {
    await db.transaction(async (tx) => {
      const current = await lockSourceBeforePrincipal(tx, actor, record),
        scope = current.loopScope
      if (!scope) throw new ApplicationAccessError()
      const run = (
        await tx
          .select()
          .from(loopRuns)
          .where(
            and(
              eq(loopRuns.id, scope.runId),
              eq(loopRuns.workspaceId, current.workspaceId),
              eq(loopRuns.agentRunId, record.runId)
            )
          )
          .for("share")
      )[0]
      if (!run) throw new ApplicationAccessError()
      await tx.insert(loopArtifactIntents).values({
        id: record.id,
        workspaceId: current.workspaceId,
        loopRunId: run.id,
        agentRunId: record.runId,
        storageReference: record.storageReference,
      })
    })
  },
  publish: async (actor, record) =>
    db.transaction(async (tx) => {
      const current = await lockSourceBeforePrincipal(tx, actor, record)
      if (!current.loopScope) throw new ApplicationAccessError()
      const intent = (
        await tx
          .select()
          .from(loopArtifactIntents)
          .where(
            and(
              intentIdentity(record),
              eq(loopArtifactIntents.workspaceId, current.workspaceId),
              eq(loopArtifactIntents.loopRunId, current.loopScope.runId),
              sql`${loopArtifactIntents.createdAt}+(${LOOP_ARTIFACT_INTENT_LEASE_MS} * interval '1 millisecond')>clock_timestamp()`
            )
          )
          .for("update")
      )[0]
      if (!intent)
        throw new ApplicationAccessError(
          "Artifact publication can no longer be confirmed."
        )
      const rows = await tx.insert(agentArtifacts).values(record).returning()
      await tx.delete(loopArtifactIntents).where(intentIdentity(record))
      return artifact(rows[0])
    }),
  recoverPublished: (_actor, record) => recoverPublication(record),
  abandon: async (_actor, record) => {
    await db.delete(loopArtifactIntents).where(intentIdentity(record))
  },
  sweepExpired: async (before, limit, blobs) => {
    const rows = await db
      .select()
      .from(loopArtifactIntents)
      .where(
        lte(
          loopArtifactIntents.createdAt,
          new Date(before.getTime() - LOOP_ARTIFACT_INTENT_LEASE_MS)
        )
      )
      .orderBy(loopArtifactIntents.createdAt)
      .limit(limit)
    let deleted = 0
    const failures: Array<{ artifactId: string; message: string }> = []
    for (const row of rows) {
      try {
        // Expired reservations cannot publish. Reconciliation takes their row
        // lock, waiting for a publication that began before the deadline.
        const published = await recoverPublication({
          id: row.id,
          runId: row.agentRunId,
          storageReference: row.storageReference,
        })
        if (!published) {
          await blobs.delete(row.storageReference)
          deleted++
        }
        await db
          .delete(loopArtifactIntents)
          .where(eq(loopArtifactIntents.id, row.id))
      } catch {
        failures.push({
          artifactId: row.id,
          message: "Loop artifact upload cleanup failed.",
        })
      }
    }
    return { examined: rows.length, deleted, failures }
  },
}
