//! Upload orchestration keeps provider I/O outside metadata transactions.
use super::*;
use crate::actor::Actor;
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use std::sync::Arc;
#[derive(Clone)]
pub struct Intent {
    pub id: String,
    pub workspace_id: String,
    pub user_id: String,
    pub input: Value,
    pub storage_reference: String,
    pub state: String,
    pub expires_at: DateTime<Utc>,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub result: Option<Value>,
}
#[async_trait]
pub trait Store: Send + Sync {
    async fn create(&self, actor: &Actor, input: Value) -> Result<Intent, UploadError>;
    /// Rechecks live actor, ownership, target, plan, quotas and fixed expiry.
    async fn prepare(
        &self,
        actor: &Actor,
        id: &str,
        issue_token: bool,
    ) -> Result<Intent, UploadError>;
    /// Metadata publication and reservation settlement share one transaction.
    async fn publish(&self, actor: &Actor, id: &str, verified: Value)
    -> Result<Value, UploadError>;
    async fn reject(&self, actor: &Actor, id: &str, reason: &str) -> Result<(), UploadError>;
    async fn cleanup_candidates(
        &self,
        before: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<Intent>, UploadError>;
    async fn mark_cleaned(&self, id: &str) -> Result<(), UploadError>;
}
/// Implementations also cancel upstream I/O when a reader is dropped.
#[async_trait]
pub trait Reader: Send {
    async fn next(&mut self) -> Result<Option<Vec<u8>>, UploadError>;
    async fn cancel(&mut self) -> Result<(), UploadError>;
}
#[async_trait]
pub trait Transport: Send + Sync {
    async fn grant(&self, intent: &Intent) -> Result<Value, UploadError>;
    async fn read(&self, reference: &str) -> Result<Option<Box<dyn Reader>>, UploadError>;
    async fn delete(&self, reference: &str) -> Result<(), UploadError>;
}
#[async_trait]
pub trait Inspector: Send + Sync {
    /// Unknown or truncated signatures fall back to text/generic classification.
    async fn detect(&self, head: &[u8]) -> Result<Option<String>, UploadError>;
}
pub struct Service {
    pub store: Arc<dyn Store>,
    pub transport: Arc<dyn Transport>,
    pub inspector: Arc<dyn Inspector>,
}
impl Service {
    pub async fn create(&self, a: &Actor, input: Value) -> Result<Value, UploadError> {
        let input =
            upload_input(input).map_err(|_| UploadError::Invalid("Invalid upload metadata."))?;
        let i = self.store.create(a, input).await?;
        Ok(
            json!({"id":i.id,"state":i.state,"expiresAt":i.expires_at.to_rfc3339_opts(SecondsFormat::Millis,true),"result":i.result}),
        )
    }
    async fn rejection<T>(
        &self,
        a: &Actor,
        id: &str,
        result: Result<T, UploadError>,
    ) -> Result<T, UploadError> {
        if let Err(error) = &result
            && error.permanent()
        {
            self.store.reject(a, id, &error.to_string()).await?;
        }
        result
    }
    pub async fn token(&self, a: &Actor, id: &str) -> Result<Value, UploadError> {
        let result = async {
            let intent = self.store.prepare(a, id, true).await?;
            if let Some(result) = intent.result {
                return Ok(json!({"state":"ready","result":result}));
            }
            Ok(json!({"state":"pending","upload":self.transport.grant(&intent).await?}))
        }
        .await;
        self.rejection(a, id, result).await
    }
    pub async fn finalize(&self, a: &Actor, id: &str) -> Result<Value, UploadError> {
        let result = async {
            let intent = self.store.prepare(a, id, false).await?;
            if let Some(result) = intent.result {
                return Ok(result);
            }
            let mut reader = self
                .transport
                .read(&intent.storage_reference)
                .await?
                .ok_or(UploadError::Unavailable(
                    "Upload the file before finalizing it.",
                ))?;
            let read = async {
                let mut verification = verification::Verification::new(&intent.input)?;
                while let Some(chunk) = reader.next().await? {
                    verification.push(&chunk)?;
                }
                verification.finish()
            }
            .await;
            let _ = reader.cancel().await;
            let verified = read?;
            let detected = self.inspector.detect(&verified.head).await.unwrap_or(None);
            self.store
                .publish(a, id, verified.metadata(detected.as_deref())?)
                .await
        }
        .await;
        self.rejection(a, id, result).await
    }
    pub async fn cancel(&self, a: &Actor, id: &str) -> Result<Value, UploadError> {
        self.store.reject(a, id, "Upload cancelled.").await?;
        Ok(json!({"ok":true}))
    }
    pub async fn sweep(&self, before: DateTime<Utc>, limit: usize) -> Result<Value, UploadError> {
        let candidates = self
            .store
            .cleanup_candidates(before, limit.clamp(1, 1000))
            .await?;
        let mut failures = vec![];
        let mut deleted = 0;
        for intent in &candidates {
            let result = async {
                self.transport.delete(&intent.storage_reference).await?;
                self.store.mark_cleaned(&intent.id).await
            }
            .await;
            if result.is_ok() {
                deleted += 1;
            } else {
                failures.push(intent.id.clone());
            }
        }
        Ok(json!({"examined":candidates.len(),"deleted":deleted,"failures":failures}))
    }
}
