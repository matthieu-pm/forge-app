use super::{CreateRun, Run, RunPatch, Usage};
use crate::{Database, StoreError};
use chrono::{DateTime, Utc};
use uuid::Uuid;

const COLUMNS: &str = "id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection::text,resolved_connection_id,resolved_model_id,reasoning_effort,routing_policy_version,routing_reason,runtime_run_id,input_tokens,output_tokens,cached_input_tokens,cost_micros,started_at,completed_at,error_code,created_at,updated_at";

pub async fn create(db: &Database, input: &CreateRun) -> Result<Run, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let row = sqlx::query_as(&format!("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection,resolved_connection_id,resolved_model_id,reasoning_effort,routing_policy_version,routing_reason,runtime_run_id,input_tokens,output_tokens,cached_input_tokens,cost_micros,started_at,completed_at,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING {COLUMNS}"))
        .bind(input.id).bind(input.thread_id).bind(&input.initiated_by_user_id).bind(input.state).bind(input.execution_kind)
        .bind(&input.requested_selection).bind(input.resolved_connection_id).bind(&input.resolved_model_id).bind(input.reasoning_effort)
        .bind(&input.routing_policy_version).bind(&input.routing_reason).bind(&input.runtime_run_id).bind(input.input_tokens)
        .bind(input.output_tokens).bind(input.cached_input_tokens).bind(input.cost_micros).bind(input.started_at)
        .bind(input.completed_at).bind(&input.error_code).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}
pub async fn get(db: &Database, workspace: &str, id: Uuid) -> Result<Option<Run>, StoreError> {
    let mut connection = db.pool().acquire().await?;
    get_in(&mut connection, workspace, id).await
}
pub(crate) async fn get_in(
    connection: &mut sqlx::PgConnection,
    workspace: &str,
    id: Uuid,
) -> Result<Option<Run>, StoreError> {
    Ok(sqlx::query_as(&format!("SELECT {COLUMNS} FROM agent_runs WHERE id=$2 AND EXISTS(SELECT 1 FROM agent_threads t WHERE t.id=agent_runs.thread_id AND t.workspace_id=$1)"))
        .bind(workspace).bind(id).fetch_optional(connection).await?)
}
pub async fn update(db: &Database, id: Uuid, patch: &RunPatch) -> Result<Option<Run>, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let row = sqlx::query_as(&format!("UPDATE agent_runs SET state=COALESCE($2,state),runtime_run_id=CASE WHEN $3 THEN $4 ELSE runtime_run_id END,input_tokens=COALESCE($5,input_tokens),output_tokens=COALESCE($6,output_tokens),cached_input_tokens=COALESCE($7,cached_input_tokens),cost_micros=COALESCE($8,cost_micros),started_at=CASE WHEN $9 THEN $10 ELSE started_at END,completed_at=CASE WHEN $11 THEN $12 ELSE completed_at END,error_code=CASE WHEN $13 THEN $14 ELSE error_code END,updated_at=$15 WHERE id=$1 RETURNING {COLUMNS}"))
        .bind(id).bind(patch.state).bind(patch.runtime_run_id.is_some()).bind(patch.runtime_run_id.as_ref().and_then(|s|s.as_deref()))
        .bind(patch.input_tokens).bind(patch.output_tokens).bind(patch.cached_input_tokens).bind(patch.cost_micros)
        .bind(patch.started_at.is_some()).bind(patch.started_at.flatten()).bind(patch.completed_at.is_some()).bind(patch.completed_at.flatten())
        .bind(patch.error_code.is_some()).bind(patch.error_code.as_ref().and_then(|s|s.as_deref())).bind(Utc::now())
        .fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}
pub async fn usage(
    db: &Database,
    workspace: &str,
    user: Option<&str>,
    since: DateTime<Utc>,
    until: Option<DateTime<Utc>>,
) -> Result<Usage, StoreError> {
    if until.is_some_and(|until| until <= since) {
        return Err(StoreError::InvalidInput);
    }
    Ok(sqlx::query_as("SELECT COALESCE(SUM(r.cost_micros) FILTER (WHERE r.created_at >= $3 AND ($4::timestamptz IS NULL OR r.created_at < $4)),0)::bigint AS cost_micros,COUNT(*) FILTER (WHERE r.state IN ('created','connecting','running','waiting-for-approval','reconnecting'))::int AS active_runs FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE t.workspace_id=$1 AND ($2::text IS NULL OR r.initiated_by_user_id=$2)")
        .bind(workspace).bind(user).bind(since).bind(until).fetch_one(db.pool()).await?)
}
