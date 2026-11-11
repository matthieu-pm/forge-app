use super::Event;
use crate::{Database, StoreError, database::JournalTransaction};
use forge_core::agents::contracts;
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

const COLUMNS: &str = "id,thread_id,run_id,source,source_event_id,sequence,type,schema_version,payload_json::text AS payload,occurred_at";
fn checked(event: Event) -> Result<Event, StoreError> {
    contracts::event(
        serde_json::to_value(&event).map_err(|_| StoreError::InvalidInput)?,
        false,
        false,
    )
    .map_err(|_| StoreError::InvalidInput)?;
    Ok(event)
}
pub(crate) async fn existing(
    conn: &mut PgConnection,
    run: Uuid,
    source: &str,
) -> Result<Option<Event>, StoreError> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM agent_events WHERE run_id=$1 AND source_event_id=$2"
    ))
    .bind(run)
    .bind(source)
    .fetch_optional(conn)
    .await?
    .map(checked)
    .transpose()
}
pub async fn append(db: &Database, input: Value) -> Result<Event, StoreError> {
    let mut tx = db.begin().await?;
    let event = append_in(&mut tx, input).await?;
    tx.commit().await?;
    Ok(event)
}
/// Allows a service to atomically record a state transition and its event.
pub async fn append_in(tx: &mut JournalTransaction, input: Value) -> Result<Event, StoreError> {
    // Validate even a replay: an existing source ID cannot bypass payload safety.
    contracts::safe_payload(&input["payload"]).map_err(|_| StoreError::InvalidInput)?;
    let input = contracts::event(input, true, false).map_err(|_| StoreError::InvalidInput)?;
    let run: Uuid = input["runId"]
        .as_str()
        .unwrap()
        .parse()
        .map_err(|_| StoreError::InvalidInput)?;
    let thread: Uuid = input["threadId"]
        .as_str()
        .unwrap()
        .parse()
        .map_err(|_| StoreError::InvalidInput)?;
    let source = input["sourceEventId"].as_str().unwrap();
    if let Some(row) = existing(tx, run, source).await? {
        return Ok(row);
    }
    tx.prepare().await?;
    for _ in 0..5 {
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence),0)::bigint+1 FROM agent_events WHERE run_id=$1",
        )
        .bind(run)
        .fetch_one(&mut **tx)
        .await?;
        let sequence = i32::try_from(sequence).map_err(|_| StoreError::Conflict)?;
        let occurred_at: chrono::DateTime<chrono::Utc> = input["occurredAt"]
            .as_str()
            .unwrap()
            .parse()
            .map_err(|_| StoreError::InvalidInput)?;
        let row = sqlx::query_as(&format!("INSERT INTO agent_events(thread_id,run_id,source_event_id,sequence,occurred_at,source,type,schema_version,payload_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING {COLUMNS}"))
            .bind(thread).bind(run).bind(source).bind(sequence).bind(occurred_at).bind(input["source"].as_str().unwrap()).bind(input["type"].as_str().unwrap())
            .bind(i32::try_from(input["schemaVersion"].as_i64().unwrap()).map_err(|_|StoreError::InvalidInput)?)
            .bind(&input["payload"]).fetch_optional(&mut **tx).await?;
        if let Some(row) = row {
            return checked(row);
        }
        if let Some(row) = existing(tx, run, source).await? {
            return Ok(row);
        }
    }
    Err(StoreError::Conflict)
}
pub async fn list_run(
    db: &Database,
    run: Uuid,
    after_sequence: i32,
) -> Result<Vec<Event>, StoreError> {
    list_run_in(&mut *db.pool().acquire().await?, run, after_sequence).await
}
pub(crate) async fn list_run_in(
    conn: &mut PgConnection,
    run: Uuid,
    after_sequence: i32,
) -> Result<Vec<Event>, StoreError> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM agent_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence"
    ))
    .bind(run)
    .bind(after_sequence.max(0))
    .fetch_all(conn)
    .await?
    .into_iter()
    .map(checked)
    .collect()
}
pub async fn list_thread(
    db: &Database,
    thread: Uuid,
    after_sequence: i32,
) -> Result<Vec<Event>, StoreError> {
    list_thread_in(&mut *db.pool().acquire().await?, thread, after_sequence).await
}
pub(crate) async fn list_thread_in(
    conn: &mut PgConnection,
    thread: Uuid,
    after_sequence: i32,
) -> Result<Vec<Event>, StoreError> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM agent_events WHERE thread_id=$1 AND sequence>$2 ORDER BY occurred_at,sequence"))
        .bind(thread).bind(after_sequence.max(0)).fetch_all(conn).await?.into_iter().map(checked).collect()
}
