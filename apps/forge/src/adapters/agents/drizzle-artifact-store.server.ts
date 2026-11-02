import "@tanstack/react-start/server-only"

import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

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
import { ApplicationAccessError } from "@/application/authorization"

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
    // Shared artifact URLs carry the same intersection of published run scope
    // and current Loop scope as the run-history reader. Viewer membership alone
    // cannot reopen an artifact hidden by a narrowed automation grant.
    const allPublic = sql`(lr.fields->>'teamAccess'='all-public-teams' AND l.fields->>'teamAccess'='all-public-teams' AND EXISTS(SELECT 1 FROM teams loop_owner WHERE loop_owner.id=l.team_id AND loop_owner.workspace_id=l.workspace_id AND loop_owner.visibility='workspace' AND loop_owner.deleted_at IS NULL))`
    const withinLoopTeam = (teamId: SQL) =>
      sql`EXISTS(SELECT 1 FROM teams loop_source_team WHERE loop_source_team.id=${teamId} AND loop_source_team.workspace_id=l.workspace_id AND loop_source_team.deleted_at IS NULL AND (loop_source_team.id=l.team_id OR (${allPublic} AND loop_source_team.visibility='workspace')))`
    const withinLoopScope = sql`CASE lr.event->>'entity'
      WHEN 'issue' THEN EXISTS(SELECT 1 FROM issues scope_issue WHERE scope_issue.workspace_id=l.workspace_id AND scope_issue.id::text=lr.event->>'entityId' AND ${withinLoopTeam(sql`scope_issue.team_id`)})
      WHEN 'project' THEN EXISTS(SELECT 1 FROM project_teams scope_project WHERE scope_project.workspace_id=l.workspace_id AND scope_project.project_id::text=lr.event->>'entityId' AND ${withinLoopTeam(sql`scope_project.team_id`)})
      WHEN 'initiative' THEN EXISTS(SELECT 1 FROM initiative_projects scope_initiative JOIN project_teams scope_project ON scope_project.project_id=scope_initiative.project_id AND scope_project.workspace_id=scope_initiative.workspace_id WHERE scope_initiative.workspace_id=l.workspace_id AND scope_initiative.initiative_id::text=lr.event->>'entityId' AND ${withinLoopTeam(sql`scope_project.team_id`)})
      WHEN 'cycle' THEN EXISTS(SELECT 1 FROM issue_cycles scope_cycle WHERE scope_cycle.workspace_id=l.workspace_id AND scope_cycle.id::text=lr.event->>'entityId' AND ${withinLoopTeam(sql`scope_cycle.team_id`)})
      WHEN 'team' THEN ${withinLoopTeam(sql`(lr.event->>'entityId')::uuid`)}
      ELSE true END`

    const rows = await db
      .select({
        artifact: agentArtifacts,
        loopEvent: sql<Record<
          string,
          unknown
        > | null>`(SELECT lr.event FROM loop_runs lr WHERE lr.agent_run_id=${agentRuns.id})`,
        activitySource: sql<Record<
          string,
          unknown
        > | null>`(SELECT CASE WHEN lr.event ? 'comment' OR lr.event ? 'update' THEN forge_loop_snapshot(lr.event->>'entity',(lr.event->>'entityId')::uuid,lr.workspace_id) ELSE NULL END FROM loop_runs lr WHERE lr.agent_run_id=${agentRuns.id})`,
      })
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
            sql`EXISTS (SELECT 1 FROM loop_runs lr JOIN team_loops l ON l.id=lr.loop_id AND l.workspace_id=lr.workspace_id WHERE lr.agent_run_id=${agentRuns.id} AND l.workspace_id=${workspaceId} AND l.deleted_at IS NULL AND ${sourceReadable} AND ${withinLoopScope} AND ${readableTeamCondition(subject, sql`l.team_id`)})`
          )
        )
      )
      .limit(1)
    const row = rows.at(0)
    if (!row) return null
    if (
      row.loopEvent?.comment !== undefined ||
      row.loopEvent?.update !== undefined
    ) {
      // This projection shares the membership/source authorization query's MVCC
      // snapshot, so an edited/deleted activity cannot remain accessible through
      // a previously copied artifact URL while its run history is hidden.
      const { loopActivityContext } =
        await import("@/application/loops/loop-context.server")
      try {
        if (!row.activitySource) return null
        loopActivityContext(row.activitySource, row.loopEvent)
      } catch (error) {
        if (error instanceof ApplicationAccessError) return null
        throw error
      }
    }
    return toRecord(row.artifact)
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
