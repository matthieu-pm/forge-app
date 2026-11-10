//! Resource visibility is independent of the team's API scope. An issues-only
//! integration can read authorized issues without also receiving teams:read.
use crate::StoreError;
use forge_core::actor::{Actor, ApiScope};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

pub fn scope(actor: &Actor, scope: ApiScope) -> Result<(), StoreError> {
    if actor.has_scope(scope) {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
pub fn privileged(actor: &Actor) -> bool {
    actor.has_role(&["owner", "admin"])
}
pub async fn team(
    connection: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), StoreError> {
    sqlx::query("SELECT t.id FROM teams t WHERE t.workspace_id=$1 AND t.id=$2 AND t.deleted_at IS NULL AND (t.visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id AND tm.user_id=$4)) FOR SHARE OF t")
        .bind(&actor.workspace_id).bind(id).bind(privileged(actor)).bind(&actor.user_id).fetch_optional(connection).await?.ok_or(StoreError::Forbidden)?;
    Ok(())
}
pub async fn team_ids(
    connection: &mut PgConnection,
    actor: &Actor,
) -> Result<Vec<Uuid>, StoreError> {
    Ok(sqlx::query_scalar("SELECT t.id FROM teams t WHERE t.workspace_id=$1 AND t.deleted_at IS NULL AND (t.visibility='workspace' OR $2 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id AND tm.user_id=$3)) ORDER BY t.id")
        .bind(&actor.workspace_id).bind(privileged(actor)).bind(&actor.user_id).fetch_all(connection).await?)
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
        "SELECT i.id,i.team_id,i.status_id FROM issues i JOIN teams t ON t.id=i.team_id AND t.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND i.archived_at IS NULL AND i.purged_at IS NULL AND t.deleted_at IS NULL AND (t.visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id AND tm.user_id=$4)) {}",
        if lock {
            "FOR UPDATE OF i FOR SHARE OF t"
        } else {
            ""
        }
    );
    sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(id)
        .bind(privileged(actor))
        .bind(&actor.user_id)
        .fetch_optional(connection)
        .await?
        .ok_or(StoreError::Forbidden)
}
