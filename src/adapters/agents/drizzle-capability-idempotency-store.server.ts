import "@tanstack/react-start/server-only"

import { and, eq, lt } from "drizzle-orm"

import type {
  CapabilityIdempotencyStore,
  CapabilityInvocationRecord,
} from "@/application/agents/capability-idempotency-store"
import { capabilityResultSchema } from "@/application/agents/capability-contract"
import { agentCapabilityInvocations, db } from "@/db"

function toRecord(
  row: typeof agentCapabilityInvocations.$inferSelect
): CapabilityInvocationRecord {
  return {
    ...row,
    state: row.state as CapabilityInvocationRecord["state"],
    outcome: row.outcome as CapabilityInvocationRecord["outcome"],
    result: row.resultJson
      ? capabilityResultSchema.parse(row.resultJson)
      : null,
  }
}

export class DrizzleCapabilityIdempotencyStore implements CapabilityIdempotencyStore {
  async reserve(record: CapabilityInvocationRecord) {
    await db
      .delete(agentCapabilityInvocations)
      .where(
        and(
          eq(agentCapabilityInvocations.workspaceId, record.workspaceId),
          eq(agentCapabilityInvocations.userId, record.userId),
          lt(agentCapabilityInvocations.expiresAt, record.createdAt)
        )
      )
    const rows = await db
      .insert(agentCapabilityInvocations)
      .values({
        ...record,
        resultJson: record.result,
      })
      .onConflictDoNothing()
      .returning()
    const inserted = rows.at(0)
    if (inserted) {
      return { kind: "reserved" as const, record: toRecord(inserted) }
    }
    const existingRows = await db
      .select()
      .from(agentCapabilityInvocations)
      .where(
        and(
          eq(agentCapabilityInvocations.workspaceId, record.workspaceId),
          eq(agentCapabilityInvocations.userId, record.userId),
          eq(agentCapabilityInvocations.runId, record.runId),
          eq(agentCapabilityInvocations.capabilityId, record.capabilityId),
          eq(
            agentCapabilityInvocations.capabilityVersion,
            record.capabilityVersion
          ),
          eq(agentCapabilityInvocations.idempotencyKey, record.idempotencyKey)
        )
      )
      .limit(1)
    const existing = existingRows.at(0)
    if (!existing) throw new Error("The capability reservation was lost.")
    return { kind: "existing" as const, record: toRecord(existing) }
  }

  async complete(
    recordId: string,
    result: CapabilityInvocationRecord["result"],
    durationMs: number
  ) {
    if (!result) return null
    const rows = await db
      .update(agentCapabilityInvocations)
      .set({
        state: "completed",
        outcome: result.ok ? "succeeded" : "failed",
        durationMs,
        resultJson: result,
      })
      .where(eq(agentCapabilityInvocations.id, recordId))
      .returning()
    const updated = rows.at(0)
    return updated ? toRecord(updated) : null
  }

  async release(recordId: string) {
    await db
      .delete(agentCapabilityInvocations)
      .where(eq(agentCapabilityInvocations.id, recordId))
  }
}
