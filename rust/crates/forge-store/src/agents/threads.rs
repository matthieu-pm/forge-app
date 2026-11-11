use super::{CreateThread, Thread, ThreadPatch};
use crate::{Database, StoreError};
use sqlx::PgConnection;
use uuid::Uuid;

const SELECT: &str = "SELECT t.*, (SELECT state FROM agent_runs r WHERE r.thread_id=t.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_state FROM agent_threads t";

pub async fn create(db: &Database, input: &CreateThread) -> Result<Thread, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let row = sqlx::query_as("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title,status,runtime_kind,runtime_session_id,created_at,updated_at,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8) RETURNING *,NULL::text AS last_run_state")
        .bind(input.id).bind(&input.workspace_id).bind(&input.created_by_user_id).bind(&input.title)
        .bind(input.status).bind(input.runtime_kind).bind(&input.runtime_session_id).bind(input.created_at)
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}
pub async fn get(db: &Database, workspace: &str, id: Uuid) -> Result<Option<Thread>, StoreError> {
    get_in(&mut *db.pool().acquire().await?, workspace, id).await
}
async fn get_in(
    conn: &mut PgConnection,
    workspace: &str,
    id: Uuid,
) -> Result<Option<Thread>, StoreError> {
    Ok(
        sqlx::query_as(&format!("{SELECT} WHERE t.workspace_id=$1 AND t.id=$2"))
            .bind(workspace)
            .bind(id)
            .fetch_optional(conn)
            .await?,
    )
}
pub async fn list(db: &Database, workspace: &str, user: &str) -> Result<Vec<Thread>, StoreError> {
    Ok(sqlx::query_as(&format!("{SELECT} WHERE t.workspace_id=$1 AND t.created_by_user_id=$2 AND NOT EXISTS(SELECT 1 FROM loop_runs lr WHERE lr.thread_id=t.id AND lr.workspace_id=t.workspace_id) ORDER BY t.last_activity_at DESC"))
        .bind(workspace).bind(user).fetch_all(db.pool()).await?)
}
pub async fn update(
    db: &Database,
    workspace: &str,
    id: Uuid,
    patch: &ThreadPatch,
) -> Result<Option<Thread>, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    sqlx::query("UPDATE agent_threads SET title=COALESCE($3,title),status=COALESCE($4,status),runtime_kind=COALESCE($5,runtime_kind),runtime_session_id=CASE WHEN $6 THEN $7 ELSE runtime_session_id END,last_activity_at=COALESCE($8,last_activity_at),updated_at=$9 WHERE workspace_id=$1 AND id=$2")
        .bind(workspace).bind(id).bind(&patch.title).bind(patch.status).bind(patch.runtime_kind)
        .bind(patch.runtime_session_id.is_some()).bind(patch.runtime_session_id.as_ref().and_then(|s|s.as_deref()))
        .bind(patch.last_activity_at).bind(chrono::Utc::now()).execute(&mut *tx).await?;
    let row = get_in(&mut tx, workspace, id).await?;
    tx.commit().await?;
    Ok(row)
}
