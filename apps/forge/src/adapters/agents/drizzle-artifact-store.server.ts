import "@tanstack/react-start/server-only"

import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type {
  AgentArtifactMetadataStore,
  StoredAgentArtifactRecord,
} from "@/application/agents/artifact-store"
import {
  currentMemberCondition,
  readableIssueCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
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

  async getAuthorized(
    workspaceId: string,
    userId: string,
    artifactId: string,
    actor?: Actor
  ) {
    const subject: {
      workspaceId: string
      userId: string
      loopScope?: Actor["loopScope"]
    } = actor ?? { workspaceId, userId }
    if (actor && (actor.workspaceId !== workspaceId || actor.userId !== userId))
      return null
    const projectReadable = sql`EXISTS(SELECT 1 FROM projects source_project WHERE source_project.workspace_id=${workspaceId} AND source_project.id::text=lr.event->>'entityId' AND ((${subject.loopScope ? subject.loopScope.allPublic : true} AND NOT EXISTS(SELECT 1 FROM project_teams source_pt WHERE source_pt.project_id=source_project.id)) OR EXISTS(SELECT 1 FROM project_teams source_pt WHERE source_pt.project_id=source_project.id AND source_pt.workspace_id=${workspaceId} AND ${readableTeamCondition(subject, sql`source_pt.team_id`)})))`
    const sourceReadable = sql`((lr.event->>'entity' IS DISTINCT FROM 'issue' OR ${readableIssueCondition(subject, sql`(lr.event->>'entityId')::uuid`)}) AND (lr.event->>'entity' IS DISTINCT FROM 'project' OR ${projectReadable}) AND (lr.event->>'entity' IS DISTINCT FROM 'team' OR ${readableTeamCondition(subject, sql`(lr.event->>'entityId')::uuid`)}) AND (lr.event->>'entity' IS DISTINCT FROM 'cycle' OR EXISTS(SELECT 1 FROM issue_cycles source_cycle WHERE source_cycle.workspace_id=${workspaceId} AND source_cycle.id::text=lr.event->>'entityId' AND ${readableTeamCondition(subject, sql`source_cycle.team_id`)})) AND (lr.event->>'entity' IS DISTINCT FROM 'initiative' OR EXISTS(SELECT 1 FROM initiative_projects source_ip JOIN project_teams source_pt ON source_pt.project_id=source_ip.project_id AND source_pt.workspace_id=source_ip.workspace_id WHERE source_ip.workspace_id=${workspaceId} AND source_ip.initiative_id::text=lr.event->>'entityId' AND ${readableTeamCondition(subject, sql`source_pt.team_id`)})))`

    const rows = await db
      .select({ artifact: agentArtifacts })
      .from(agentArtifacts)
      .innerJoin(agentRuns, eq(agentArtifacts.runId, agentRuns.id))
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(
        and(
          currentMemberCondition(subject),
          eq(agentArtifacts.id, artifactId),
          eq(agentThreads.workspaceId, workspaceId),
          or(
            and(
              eq(agentThreads.createdByUserId, userId),
              sql`NOT EXISTS (SELECT 1 FROM loop_runs lr WHERE lr.agent_run_id=${agentRuns.id})`
            ),
            sql`EXISTS (SELECT 1 FROM loop_runs lr JOIN team_loops l ON l.id=lr.loop_id AND l.workspace_id=lr.workspace_id WHERE lr.agent_run_id=${agentRuns.id} AND l.workspace_id=${workspaceId} AND l.deleted_at IS NULL AND ${sourceReadable} AND ${readableTeamCondition(subject, sql`l.team_id`)})`
          )
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
