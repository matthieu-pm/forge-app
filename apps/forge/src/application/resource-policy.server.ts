import "@tanstack/react-start/server-only"
import { sql } from "drizzle-orm"
import { ApplicationAccessError, hasScope } from "./authorization"
import { currentCommandActor } from "./commands/command-actor.server"
import type { SQL, SQLWrapper } from "drizzle-orm"
import type { Actor, ApiScope } from "./actor"
import type { DatabaseExecutor, Transaction } from "@/db"
import { db } from "@/db"

type ResourceSubject = {
  workspaceId: string
  userId: string | SQLWrapper
  loopScope?: Actor["loopScope"]
}

/** Authenticated adapters supply Actors; reload and lock live authority in one transaction. */
export async function requireCurrentActor(
  actor: Actor,
  executor: DatabaseExecutor = db
): Promise<Actor> {
  return executor === db
    ? db.transaction((tx) => currentCommandActor(tx, actor))
    : currentCommandActor(executor as Transaction, actor)
}

export function requireResourceScope(actor: Actor, scope: ApiScope) {
  // Only first-party sessions are allowed an unlimited credential scope.
  if (
    (actor.scopes === null && actor.authentication.kind !== "session") ||
    !hasScope(actor, scope)
  )
    throw new ApplicationAccessError(
      `The credential cannot ${scope.replace(":", " ")}.`
    )
}

export function currentMemberCondition(actor: ResourceSubject): SQL {
  if (actor.loopScope)
    return sql`EXISTS (SELECT 1 FROM loop_runs lr JOIN team_loops l ON l.id=lr.loop_id AND l.workspace_id=lr.workspace_id WHERE lr.id=${actor.loopScope.runId} AND l.id=${actor.loopScope.loopId} AND l.workspace_id=${actor.workspaceId} AND l.enabled AND l.deleted_at IS NULL AND lr.state IN ('running','waiting-for-approval'))`
  return sql`EXISTS (SELECT 1 FROM member authz_member WHERE authz_member.organization_id = ${actor.workspaceId} AND authz_member.user_id = ${actor.userId})`
}

function privilegedCondition(actor: ResourceSubject): SQL {
  return sql`EXISTS (SELECT 1 FROM member authz_role WHERE authz_role.organization_id = ${actor.workspaceId} AND authz_role.user_id = ${actor.userId} AND string_to_array(replace(authz_role.role, ' ', ''), ',') && ARRAY['owner','admin']::text[])`
}

/** Resource predicates deliberately do not require teams:read for issues:read. */
export function readableTeamCondition(
  actor: ResourceSubject,
  teamId: SQLWrapper,
  includeArchived = false
): SQL {
  const scope = actor.loopScope
    ? sql`(authz_team.id=${actor.loopScope.teamId} OR (${actor.loopScope.allPublic} AND authz_team.visibility='workspace'))`
    : sql`true`
  const privateAccess = actor.loopScope
    ? sql`authz_team.id=${actor.loopScope.teamId}`
    : privilegedCondition(actor)
  return sql`EXISTS (SELECT 1 FROM teams authz_team WHERE authz_team.id = ${teamId} AND authz_team.workspace_id = ${actor.workspaceId} AND ${includeArchived ? sql`true` : sql`authz_team.deleted_at IS NULL`} AND ${scope} AND ${currentMemberCondition(actor)} AND (authz_team.visibility = 'workspace' OR ${privateAccess} OR EXISTS (SELECT 1 FROM team_members authz_tm WHERE authz_tm.workspace_id = ${actor.workspaceId} AND authz_tm.team_id = authz_team.id AND authz_tm.user_id = ${actor.userId})))`
}

export function readableProjectCondition(
  actor: Actor,
  projectId: SQLWrapper
): SQL {
  return sql`EXISTS (SELECT 1 FROM projects authz_project WHERE authz_project.id = ${projectId} AND authz_project.workspace_id = ${actor.workspaceId} AND ${currentMemberCondition(actor)} AND ((${actor.loopScope ? sql`${actor.loopScope.allPublic}` : sql`true`} AND NOT EXISTS (SELECT 1 FROM project_teams authz_pt WHERE authz_pt.project_id = authz_project.id)) OR EXISTS (SELECT 1 FROM project_teams authz_pt WHERE authz_pt.project_id = authz_project.id AND authz_pt.workspace_id = ${actor.workspaceId} AND ${readableTeamCondition(actor, sql`authz_pt.team_id`)})))`
}

export function readableIssueCondition(
  actor: ResourceSubject,
  issueId: SQLWrapper,
  includeInactive = false
): SQL {
  return sql`EXISTS (SELECT 1 FROM issues authz_issue WHERE authz_issue.id = ${issueId} AND authz_issue.workspace_id = ${actor.workspaceId} AND ${includeInactive ? sql`true` : sql`authz_issue.deleted_at IS NULL AND authz_issue.archived_at IS NULL`} AND authz_issue.purged_at IS NULL AND ${readableTeamCondition(actor, sql`authz_issue.team_id`)})`
}

export function readableDocumentCondition(
  actor: Actor,
  documentId: SQLWrapper
): SQL {
  return sql`EXISTS (SELECT 1 FROM documents authz_doc WHERE authz_doc.id = ${documentId} AND authz_doc.workspace_id = ${actor.workspaceId} AND authz_doc.deleted_at IS NULL AND ${currentMemberCondition(actor)} AND (((${actor.loopScope ? sql`${actor.loopScope.allPublic}` : sql`true`}) AND authz_doc.shared_with_workspace) OR ((${actor.loopScope ? sql`${actor.loopScope.allPublic}` : sql`true`}) AND authz_doc.team_id IS NULL AND authz_doc.issue_id IS NULL AND authz_doc.project_id IS NULL) OR ${readableTeamCondition(actor, sql`authz_doc.team_id`)} OR ${readableIssueCondition(actor, sql`authz_doc.issue_id`)} OR ${readableProjectCondition(actor, sql`authz_doc.project_id`)}))`
}
