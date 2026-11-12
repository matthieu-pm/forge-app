//! Resource visibility is independent of the team's API scope. An issues-only
//! integration can read authorized issues without also receiving teams:read.
use crate::StoreError;
use forge_core::actor::{Actor, ApiScope};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

#[cfg(test)]
mod tests;

pub fn scope(actor: &Actor, scope: ApiScope) -> Result<(), StoreError> {
    if actor.has_scope(scope) {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
pub fn privileged(actor: &Actor) -> bool {
    actor.loop_scope.is_none() && actor.has_role(&["owner", "admin"])
}
// These fragments only accept column expressions owned by the adapter. Bindings
// are always workspace $1, live administrative role $2, and live user $3.
// The actor must have been reauthorized in the same transaction. UUIDs are parsed
// before formatting; no actor-supplied text is ever interpolated into SQL.
fn loop_ids(actor: &Actor) -> Option<(Uuid, Uuid, Uuid)> {
    let scope = actor.loop_scope.as_ref()?;
    Some((
        scope.loop_id.parse().ok()?,
        scope.run_id.parse().ok()?,
        scope.team_id.parse().ok()?,
    ))
}
fn current_member(actor: &Actor) -> String {
    if actor.loop_scope.is_some() {
        let condition = match loop_ids(actor) {
            Some((loop_id, run_id, _)) => format!(
                "EXISTS(SELECT 1 FROM loop_runs authz_run JOIN team_loops authz_loop ON authz_loop.id=authz_run.loop_id AND authz_loop.workspace_id=authz_run.workspace_id WHERE authz_run.id='{run_id}'::uuid AND authz_loop.id='{loop_id}'::uuid AND authz_loop.workspace_id=$1 AND authz_loop.enabled AND authz_loop.deleted_at IS NULL AND authz_run.state IN ('running','waiting-for-approval'))"
            ),
            None => "FALSE".into(),
        };
        // Every caller binds the same three parameters, including when a loop
        // has no human membership or its malformed scope fails closed.
        return format!(
            "($1::text IS NOT NULL AND $2::boolean IS NOT NULL AND $3::text IS NOT NULL AND {condition})"
        );
    }
    "EXISTS(SELECT 1 FROM member authz_member WHERE authz_member.organization_id=$1 AND authz_member.user_id=$3)".into()
}
pub(crate) fn readable_team(actor: &Actor, column: &'static str) -> String {
    readable_team_including_archived(actor, column, false)
}
pub(crate) fn readable_team_including_archived(
    actor: &Actor,
    column: &'static str,
    include_archived: bool,
) -> String {
    let visibility = if let Some(scope) = &actor.loop_scope {
        match loop_ids(actor) {
            Some((_, _, team)) => format!(
                "(authz_team.id='{team}'::uuid OR ({} AND authz_team.visibility='workspace'))",
                scope.all_public
            ),
            None => "FALSE".into(),
        }
    } else {
        "(authz_team.visibility='workspace' OR $2 OR EXISTS(SELECT 1 FROM team_members authz_tm WHERE authz_tm.workspace_id=$1 AND authz_tm.team_id=authz_team.id AND authz_tm.user_id=$3))".into()
    };
    format!(
        "EXISTS(SELECT 1 FROM teams authz_team WHERE authz_team.id={column} AND authz_team.workspace_id=$1 AND {} AND {} AND {visibility})",
        if include_archived {
            "TRUE"
        } else {
            "authz_team.deleted_at IS NULL"
        },
        current_member(actor)
    )
}
pub(crate) fn readable_issue(actor: &Actor, column: &'static str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM issues authz_issue WHERE authz_issue.id={column} AND authz_issue.workspace_id=$1 AND authz_issue.deleted_at IS NULL AND authz_issue.archived_at IS NULL AND authz_issue.purged_at IS NULL AND {})",
        readable_team(actor, "authz_issue.team_id")
    )
}
pub(crate) fn retained_issue(actor: &Actor, column: &'static str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM issues authz_issue WHERE authz_issue.id={column} AND authz_issue.workspace_id=$1 AND authz_issue.purged_at IS NULL AND {})",
        readable_team(actor, "authz_issue.team_id")
    )
}
pub(crate) fn readable_project(actor: &Actor, column: &'static str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM projects authz_project WHERE authz_project.id={column} AND authz_project.workspace_id=$1 AND {} AND (({} AND NOT EXISTS(SELECT 1 FROM project_teams authz_pt WHERE authz_pt.project_id=authz_project.id)) OR EXISTS(SELECT 1 FROM project_teams authz_pt WHERE authz_pt.project_id=authz_project.id AND authz_pt.workspace_id=$1 AND {})))",
        current_member(actor),
        actor.loop_scope.as_ref().is_none_or(|s| s.all_public),
        readable_team(actor, "authz_pt.team_id")
    )
}
pub(crate) fn readable_document(actor: &Actor, column: &'static str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM documents authz_doc WHERE authz_doc.id={column} AND authz_doc.workspace_id=$1 AND authz_doc.deleted_at IS NULL AND {} AND (({} AND (authz_doc.shared_with_workspace OR (authz_doc.team_id IS NULL AND authz_doc.issue_id IS NULL AND authz_doc.project_id IS NULL))) OR {} OR {} OR {}))",
        current_member(actor),
        actor.loop_scope.as_ref().is_none_or(|s| s.all_public),
        readable_team(actor, "authz_doc.team_id"),
        readable_issue(actor, "authz_doc.issue_id"),
        readable_project(actor, "authz_doc.project_id")
    )
}
pub async fn team(
    connection: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), StoreError> {
    sqlx::query(&format!(
        "SELECT t.id FROM teams t WHERE t.id=$4 AND {} FOR SHARE OF t",
        readable_team(actor, "t.id")
    ))
    .bind(&actor.workspace_id)
    .bind(privileged(actor))
    .bind(&actor.user_id)
    .bind(id)
    .fetch_optional(connection)
    .await?
    .ok_or(StoreError::Forbidden)?;
    Ok(())
}
pub async fn team_ids(
    connection: &mut PgConnection,
    actor: &Actor,
) -> Result<Vec<Uuid>, StoreError> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT t.id FROM teams t WHERE {} ORDER BY t.id",
        readable_team(actor, "t.id")
    ))
    .bind(&actor.workspace_id)
    .bind(privileged(actor))
    .bind(&actor.user_id)
    .fetch_all(connection)
    .await?)
}
#[derive(FromRow)]
pub struct IssueIdentity {
    pub id: Uuid,
    pub team_id: Uuid,
    pub status_id: String,
}
pub async fn issue(
    connection: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<IssueIdentity, StoreError> {
    let query = format!(
        "SELECT i.id,i.team_id,i.status_id FROM issues i JOIN teams t ON t.id=i.team_id AND t.workspace_id=i.workspace_id WHERE i.id=$4 AND {} {}",
        readable_issue(actor, "i.id"),
        if lock {
            "FOR UPDATE OF i FOR SHARE OF t"
        } else {
            ""
        }
    );
    sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(privileged(actor))
        .bind(&actor.user_id)
        .bind(id)
        .fetch_optional(connection)
        .await?
        .ok_or(StoreError::Forbidden)
}
