//! Private attachment/artifact bytes and metadata. Provider I/O stays outside
//! publication transactions; ambiguous commits never trigger blind byte deletion.
use crate::{Database, StoreError, authority::current_actor};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    agents::{
        contracts,
        files::{self as policy, Blobs, Code, Error, Settings},
    },
    files::checksum,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::sync::Arc;
use uuid::Uuid;

mod artifacts;
mod attachments;
mod loop_artifacts;
mod metadata;
mod retention;
pub use retention::Sweep;

#[derive(Clone)]
pub struct Service {
    pub database: Database,
    pub blobs: Arc<dyn Blobs>,
    pub settings: Settings,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}
impl Service {
    pub fn new(database: Database, blobs: Arc<dyn Blobs>) -> Self {
        Self {
            database,
            blobs,
            settings: Settings::default(),
            now: Arc::new(Utc::now),
        }
    }
    fn time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis((self.now)().timestamp_millis()).unwrap()
    }
    async fn authorize(&self, actor: &Actor, scope: ApiScope) -> Result<Actor, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, scope).await?;
        tx.commit().await?;
        Ok(actor)
    }
    /// Confirm whether metadata owns these exact bytes before cleanup after an
    /// uncertain response. A failed probe retains bytes for reconciliation.
    async fn cleanup_unpublished(&self, table: &str, id: Uuid, reference: &str) {
        let query = match table {
            "agent_artifacts" => {
                "SELECT EXISTS(SELECT 1 FROM agent_artifacts WHERE id=$1 AND storage_reference=$2)"
            }
            "agent_attachments" => {
                "SELECT EXISTS(SELECT 1 FROM agent_attachments WHERE id=$1 AND storage_reference=$2)"
            }
            _ => return,
        };
        let absent = async {
            let mut tx = self.database.begin().await?;
            publication_lock(&mut tx, id).await?;
            let exists = sqlx::query_scalar::<_, bool>(query)
                .bind(id)
                .bind(reference)
                .fetch_one(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok::<_, StoreError>(!exists)
        }
        .await;
        if matches!(absent, Ok(true)) {
            let _ = self.blobs.delete(reference).await;
        }
    }
}
fn error(code: Code, message: impl Into<String>) -> StoreError {
    Error::new(code, message).into()
}
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn optional_iso(at: Option<DateTime<Utc>>) -> Option<String> {
    at.map(iso)
}
async fn live(
    connection: &mut PgConnection,
    actor: &Actor,
    scope: ApiScope,
) -> Result<Actor, StoreError> {
    let actor = current_actor(connection, actor).await?;
    if !actor.has_scope(scope) {
        return Err(StoreError::Forbidden);
    }
    Ok(actor)
}
fn expiry(now: DateTime<Utc>, units: u64, seconds: u64) -> Result<DateTime<Utc>, StoreError> {
    units
        .checked_mul(seconds)
        .and_then(|n| i64::try_from(n).ok())
        .and_then(Duration::try_seconds)
        .and_then(|duration| now.checked_add_signed(duration))
        .ok_or(StoreError::InvalidInput)
}
fn matches(bytes: &[u8], size: i32, hash: &str) -> bool {
    bytes.len() as u64 == size as u64 && checksum(bytes) == hash
}
async fn publication_lock(connection: &mut PgConnection, id: Uuid) -> Result<(), StoreError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("agent-file-publication:{id}"))
        .execute(connection)
        .await?;
    Ok(())
}
