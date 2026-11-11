use super::Preference;
use crate::{Database, StoreError};
use uuid::Uuid;

pub async fn get(db: &Database, thread: Uuid) -> Result<Option<Preference>, StoreError> {
    Ok(
        sqlx::query_as("SELECT * FROM thread_model_preferences WHERE thread_id=$1")
            .bind(thread)
            .fetch_optional(db.pool())
            .await?,
    )
}
pub async fn upsert(db: &Database, input: &Preference) -> Result<Preference, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let row = sqlx::query_as("INSERT INTO thread_model_preferences(thread_id,mode,selected_connection_id,selected_model_id,selected_effort,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(thread_id) DO UPDATE SET mode=EXCLUDED.mode,selected_connection_id=EXCLUDED.selected_connection_id,selected_model_id=EXCLUDED.selected_model_id,selected_effort=EXCLUDED.selected_effort,updated_at=EXCLUDED.updated_at RETURNING *")
        .bind(input.thread_id).bind(input.mode).bind(input.selected_connection_id).bind(&input.selected_model_id).bind(input.selected_effort).bind(input.updated_at).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}
