import "@tanstack/react-start/server-only"

import { and, asc, eq, isNull, lte } from "drizzle-orm"

import type {
  AgentArtifactMetadataStore,
  StoredAgentArtifactRecord,
} from "@/application/agents/artifact-store"
import { currentMemberCondition } from "@/application/resource-policy.server"
import { agentArtifacts, agentRuns, agentThreads, db } from "@/db"

function toRecord(
  artifact: typeof agentArtifacts.$inferSelect
): StoredAgentArtifactRecord {
  return {
    ...artifact,
    kind: artifact.kind as StoredAgentArtifactRecord["kind"],
  }
}

export class DrizzleAgentArtifactStore implements AgentArtifactMetadataStore {
  async create(input: StoredAgentArtifactRecord) {
    const rows = await db.insert(agentArtifacts).values(input).returning()
    const artifact = rows.at(0)
    if (!artifact) throw new Error("The artifact metadata was not stored.")
    return toRecord(artifact)
  }

  async findByRunChecksumAndName(
    runId: string,
    checksum: string,
    name: string
  ) {
    const rows = await db
      .select()
      .from(agentArtifacts)
      .where(
        and(
          eq(agentArtifacts.runId, runId),
          eq(agentArtifacts.checksum, checksum),
          eq(agentArtifacts.name, name)
        )
      )
      .limit(1)
    const artifact = rows.at(0)
    return artifact ? toRecord(artifact) : null
  }

  async getAuthorized(workspaceId: string, userId: string, artifactId: string) {
    const rows = await db
      .select({ artifact: agentArtifacts })
      .from(agentArtifacts)
      .innerJoin(agentRuns, eq(agentArtifacts.runId, agentRuns.id))
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(
        and(
          currentMemberCondition({ workspaceId, userId }),
          eq(agentArtifacts.id, artifactId),
          eq(agentThreads.workspaceId, workspaceId),
          eq(agentThreads.createdByUserId, userId)
        )
      )
      .limit(1)
    const artifact = rows.at(0)?.artifact
    return artifact ? toRecord(artifact) : null
  }

  async listExpired(before: Date, limit: number) {
    const rows = await db
      .select()
      .from(agentArtifacts)
      .where(
        and(
          isNull(agentArtifacts.deletedAt),
          lte(agentArtifacts.retentionExpiresAt, before)
        )
      )
      .orderBy(asc(agentArtifacts.retentionExpiresAt))
      .limit(limit)
    return rows.map(toRecord)
  }

  async markDeleted(artifactId: string, deletedAt: Date) {
    const rows = await db
      .update(agentArtifacts)
      .set({ deletedAt })
      .where(
        and(eq(agentArtifacts.id, artifactId), isNull(agentArtifacts.deletedAt))
      )
      .returning()
    const artifact = rows.at(0)
    return artifact ? toRecord(artifact) : null
  }
}
