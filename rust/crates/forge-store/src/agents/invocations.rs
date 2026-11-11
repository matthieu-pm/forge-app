use super::{Invocation, Outcome};
use crate::{Database, StoreError};
use forge_core::agents::contracts;
use serde_json::Value;
use uuid::Uuid;

const COLUMNS: &str = "id,workspace_id,user_id,run_id,approval_id,capability_id,capability_version,idempotency_key,input_hash,state,outcome,duration_ms,COALESCE(result_json,'null'::jsonb)::text AS result,created_at,expires_at";
fn checked(mut row: Invocation) -> Result<Invocation, StoreError> {
    if !row.result.is_null() {
        row.result =
            contracts::capability_result(row.result).map_err(|_| StoreError::InvalidInput)?;
    }
    Ok(row)
}
#[derive(Debug)]
pub enum Reservation {
    Reserved(Invocation),
    Existing(Invocation),
}
pub async fn reserve(db: &Database, input: &Invocation) -> Result<Reservation, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let inserted = sqlx::query_as(&format!("INSERT INTO agent_capability_invocations(id,workspace_id,user_id,run_id,approval_id,capability_id,capability_version,idempotency_key,input_hash,state,outcome,duration_ms,result_json,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING {COLUMNS}"))
        .bind(input.id).bind(&input.workspace_id).bind(&input.user_id).bind(input.run_id).bind(input.approval_id).bind(&input.capability_id).bind(&input.capability_version)
        .bind(&input.idempotency_key).bind(&input.input_hash).bind(input.state).bind(input.outcome).bind(input.duration_ms)
        .bind((!input.result.is_null()).then_some(&input.result)).bind(input.created_at).bind(input.expires_at).fetch_optional(&mut *tx).await?;
    let result = if let Some(row) = inserted {
        Reservation::Reserved(checked(row)?)
    } else {
        let row = sqlx::query_as(&format!("SELECT {COLUMNS} FROM agent_capability_invocations WHERE workspace_id=$1 AND user_id=$2 AND run_id=$3 AND capability_id=$4 AND capability_version=$5 AND idempotency_key=$6 LIMIT 1"))
            .bind(&input.workspace_id).bind(&input.user_id).bind(input.run_id).bind(&input.capability_id).bind(&input.capability_version).bind(&input.idempotency_key)
            .fetch_optional(&mut *tx).await?.ok_or(StoreError::Conflict)?;
        Reservation::Existing(checked(row)?)
    };
    tx.commit().await?;
    Ok(result)
}
pub async fn complete(
    db: &Database,
    id: Uuid,
    result: Value,
    duration_ms: i32,
) -> Result<Option<Invocation>, StoreError> {
    if result.is_null() {
        return Ok(None);
    }
    let result = contracts::capability_result(result).map_err(|_| StoreError::InvalidInput)?;
    let outcome = if result["ok"] == true {
        Outcome::Succeeded
    } else {
        Outcome::Failed
    };
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let row = sqlx::query_as(&format!("UPDATE agent_capability_invocations SET state='completed',outcome=$2,duration_ms=$3,result_json=$4 WHERE id=$1 RETURNING {COLUMNS}"))
        .bind(id).bind(outcome).bind(duration_ms).bind(&result).fetch_optional(&mut *tx).await?.map(checked).transpose()?;
    tx.commit().await?;
    Ok(row)
}
pub async fn release(db: &Database, id: Uuid) -> Result<(), StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    sqlx::query("DELETE FROM agent_capability_invocations WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}
