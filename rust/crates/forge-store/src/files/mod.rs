//! Private file metadata. Bytes stay outside database transactions.
use crate::{Database, StoreError, authority::current_actor, resource_policy as policy};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    files::{self as contract, UploadError, upload},
};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::sync::Arc;
use uuid::Uuid;
mod authorization;
mod lookup;
mod publication;
pub use lookup::FileLookup;
mod reservations;
use authorization::{assert_policy, authorize_target, fence};

#[derive(Clone)]
pub struct UploadStore {
    pub database: Database,
    pub agent_ui: bool,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}
impl UploadStore {
    pub fn new(database: Database) -> Self {
        let enabled = std::env::var("FORGE_FEATURE_AGENT_UI")
            .ok()
            .is_none_or(|v| {
                !matches!(
                    forge_core::text::trim(&v).to_lowercase().as_str(),
                    "0" | "false" | "off" | "no"
                )
            });
        Self {
            database,
            agent_ui: enabled,
            now: Arc::new(Utc::now),
        }
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn id(s: &str) -> Result<Uuid, StoreError> {
    if !forge_core::text::is_uuid(s) {
        return Err(StoreError::InvalidInput);
    }
    s.parse().map_err(|_| StoreError::InvalidInput)
}
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn invalid(message: &'static str) -> StoreError {
    UploadError::Invalid(message).into()
}
fn upload_error(error: StoreError) -> UploadError {
    match error {
        StoreError::Upload(e) => e,
        StoreError::Unauthenticated => UploadError::Unauthenticated,
        StoreError::Forbidden
        | StoreError::NoActiveWorkspace
        | StoreError::EmailNotVerified
        | StoreError::NotFound => {
            UploadError::Access("You do not have permission to perform this action.")
        }
        StoreError::InvalidInput => UploadError::Invalid("Invalid upload metadata."),
        StoreError::CommandReused | StoreError::Conflict => {
            UploadError::Conflict("This upload key was already used with different input.")
        }
        _ => UploadError::Transport,
    }
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    workspace_id: String,
    user_id: String,
    command_key: Uuid,
    input_hash: String,
    target: Value,
    name: String,
    content_type: String,
    size_bytes: i32,
    checksum: String,
    storage_reference: String,
    state: String,
    expires_at: DateTime<Utc>,
    token_expires_at: Option<DateTime<Utc>>,
    attempts: Value,
    result: Option<Value>,
}
impl Row {
    fn intent(self) -> upload::Intent {
        upload::Intent {
            id: self.id.to_string(),
            workspace_id: self.workspace_id,
            user_id: self.user_id,
            input: json!({"commandKey":self.command_key,"target":self.target,"name":self.name,"contentType":self.content_type,"sizeBytes":self.size_bytes,"checksum":self.checksum}),
            storage_reference: self.storage_reference,
            state: self.state,
            expires_at: self.expires_at,
            token_expires_at: self.token_expires_at,
            result: self.result,
        }
    }
    fn pending(&self, now: DateTime<Utc>) -> Result<(), StoreError> {
        if self.expires_at <= now {
            return Err(invalid("This upload has expired. Start a new upload."));
        }
        if self.state != "pending" {
            return Err(invalid(
                "This upload was refused or cancelled. Start a new upload.",
            ));
        }
        Ok(())
    }
}
async fn owned(c: &mut PgConnection, a: &Actor, key: Uuid) -> Result<Row, StoreError> {
    sqlx::query_as("SELECT * FROM file_upload_intents WHERE workspace_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE")
        .bind(&a.workspace_id).bind(&a.user_id).bind(key).fetch_optional(c).await?.ok_or(StoreError::Forbidden)
}
#[async_trait::async_trait]
impl upload::Store for UploadStore {
    async fn create(&self, a: &Actor, input: Value) -> Result<upload::Intent, UploadError> {
        self.create(a, input).await.map_err(upload_error)
    }
    async fn prepare(
        &self,
        a: &Actor,
        key: &str,
        token: bool,
    ) -> Result<upload::Intent, UploadError> {
        self.prepare(a, key, token).await.map_err(upload_error)
    }
    async fn publish(&self, a: &Actor, key: &str, verified: Value) -> Result<Value, UploadError> {
        self.publish(a, key, verified).await.map_err(upload_error)
    }
    async fn reject(&self, a: &Actor, key: &str, reason: &str) -> Result<(), UploadError> {
        self.reject(a, key, reason).await.map_err(upload_error)
    }
    async fn cleanup_candidates(
        &self,
        before: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<upload::Intent>, UploadError> {
        self.cleanup_candidates(before, limit)
            .await
            .map_err(upload_error)
    }
    async fn mark_cleaned(&self, key: &str) -> Result<(), UploadError> {
        self.mark_cleaned(key).await.map_err(upload_error)
    }
}
