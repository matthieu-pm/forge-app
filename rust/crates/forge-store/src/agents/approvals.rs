use super::{Approval, ApprovalState};
use crate::{StoreError, database::JournalTransaction};
use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

const COLUMNS: &str = "id,workspace_id,run_id,requested_for_user_id,capability_id,capability_version,risk,input_hash,redacted_input_summary::text,state,nonce,requested_at,expires_at,resolved_at,resolved_by_user_id";

pub async fn create(tx: &mut JournalTransaction, input: &Approval) -> Result<Approval, StoreError> {
    tx.prepare().await?;
    let row = sqlx::query_as(&format!("INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,capability_version,risk,input_hash,redacted_input_summary,state,nonce,requested_at,expires_at,resolved_at,resolved_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING RETURNING {COLUMNS}"))
        .bind(input.id).bind(&input.workspace_id).bind(input.run_id).bind(&input.requested_for_user_id).bind(&input.capability_id).bind(&input.capability_version)
        .bind(input.risk).bind(&input.input_hash).bind(&input.redacted_input_summary).bind(input.state).bind(&input.nonce)
        .bind(input.requested_at).bind(input.expires_at).bind(input.resolved_at).bind(&input.resolved_by_user_id).fetch_optional(&mut **tx).await?;
    if let Some(row) = row {
        return Ok(row);
    }
    get(tx, input.id).await?.ok_or(StoreError::Conflict)
}
pub async fn get(conn: &mut PgConnection, id: Uuid) -> Result<Option<Approval>, StoreError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM agent_approvals WHERE id=$1"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?)
}
pub struct ApprovedQuery<'a> {
    pub workspace_id: &'a str,
    pub run_id: Uuid,
    pub requested_for_user_id: &'a str,
    pub capability_id: &'a str,
    pub capability_version: &'a str,
    pub input_hash: &'a str,
}
/// Expiration and fresh authority are service decisions, not persistence filters.
pub async fn find_approved(
    conn: &mut PgConnection,
    input: &ApprovedQuery<'_>,
) -> Result<Option<Approval>, StoreError> {
    Ok(sqlx::query_as(&format!("SELECT {COLUMNS} FROM agent_approvals WHERE workspace_id=$1 AND run_id=$2 AND requested_for_user_id=$3 AND capability_id=$4 AND capability_version=$5 AND input_hash=$6 AND state='approved' LIMIT 1"))
        .bind(input.workspace_id).bind(input.run_id).bind(input.requested_for_user_id).bind(input.capability_id).bind(input.capability_version).bind(input.input_hash).fetch_optional(conn).await?)
}
pub async fn list_program_grants(
    conn: &mut PgConnection,
    workspace: &str,
    run: Uuid,
    user: &str,
) -> Result<Vec<Approval>, StoreError> {
    Ok(sqlx::query_as(&format!("SELECT {COLUMNS} FROM agent_approvals WHERE workspace_id=$1 AND run_id=$2 AND requested_for_user_id=$3 AND capability_id='program.execute' AND state='approved'"))
        .bind(workspace).bind(run).bind(user).fetch_all(conn).await?)
}
pub async fn compare_and_set(
    tx: &mut JournalTransaction,
    id: Uuid,
    expected: ApprovalState,
    next: ApprovalState,
    resolved_at: Option<DateTime<Utc>>,
    resolved_by: Option<&str>,
) -> Result<Option<Approval>, StoreError> {
    tx.prepare().await?;
    compare_and_set_in(tx, id, expected, next, resolved_at, resolved_by).await
}
/// The caller must already have prepared the surrounding journal transaction.
pub(crate) async fn compare_and_set_in(
    connection: &mut PgConnection,
    id: Uuid,
    expected: ApprovalState,
    next: ApprovalState,
    resolved_at: Option<DateTime<Utc>>,
    resolved_by: Option<&str>,
) -> Result<Option<Approval>, StoreError> {
    Ok(sqlx::query_as(&format!("UPDATE agent_approvals SET state=$3,resolved_at=COALESCE($4,resolved_at),resolved_by_user_id=COALESCE($5,resolved_by_user_id) WHERE id=$1 AND state=$2 RETURNING {COLUMNS}"))
        .bind(id).bind(expected).bind(next).bind(resolved_at).bind(resolved_by.filter(|s|!s.is_empty())).fetch_optional(connection).await?)
}
