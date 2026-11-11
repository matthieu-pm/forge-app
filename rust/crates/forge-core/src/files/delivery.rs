use super::*;
use crate::actor::{Actor, Authentication};
use async_trait::async_trait;
use std::sync::Arc;
#[derive(Clone, Debug)]
pub struct File {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size_bytes: usize,
    pub checksum: String,
    pub storage_reference: String,
}
#[async_trait]
pub trait Lookup: Send + Sync {
    /// Refreshes session/membership and source visibility on every invocation.
    async fn lookup(&self, actor: &Actor, target: &Value) -> Result<Option<File>, DeliveryError>;
}
#[async_trait]
pub trait Blobs: Send + Sync {
    /// Implementations bound reads and cancel upstream work on timeout or drop.
    async fn get(
        &self,
        reference: &str,
        max_bytes: usize,
        timeout_ms: u64,
    ) -> Result<Option<Vec<u8>>, DeliveryError>;
}
pub struct Service {
    pub lookup: Arc<dyn Lookup>,
    pub blobs: Arc<dyn Blobs>,
    pub secret: String,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Service {
    async fn metadata(&self, a: &Actor, target: &Value) -> Result<File, DeliveryError> {
        delivery_target(target.clone()).map_err(|_| DeliveryError::NotFound)?;
        if !matches!(a.authentication, Authentication::Session { .. }) || a.scopes.is_some() {
            return Err(DeliveryError::NotFound);
        }
        self.lookup
            .lookup(a, target)
            .await?
            .ok_or(DeliveryError::NotFound)
    }
    pub async fn grant(
        &self,
        a: &Actor,
        target: &Value,
        purpose: &str,
    ) -> Result<Value, DeliveryError> {
        let file = self.metadata(a, target).await?;
        if purpose == "preview" && file.size_bytes > PREVIEW_MAX_BYTES {
            return Err(DeliveryError::PreviewUnavailable);
        }
        let token = grants::mint(&self.secret, a, target, purpose, (self.now)())?;
        Ok(
            json!({"file":{"id":file.id,"name":file.name,"contentType":file.content_type,"sizeBytes":file.size_bytes},"url":format!("/api/files/{}/{}/{purpose}?token={token}",target["kind"].as_str().unwrap(),target["id"].as_str().unwrap()),"expiresInSeconds":GRANT_SECONDS}),
        )
    }
    pub async fn read(
        &self,
        a: &Actor,
        target: &Value,
        purpose: &str,
        token: &str,
    ) -> Result<(File, Vec<u8>), DeliveryError> {
        grants::verify(&self.secret, token, a, target, purpose, (self.now)())?;
        let file = self.metadata(a, target).await?;
        let limit = if purpose == "preview" {
            PREVIEW_MAX_BYTES
        } else {
            MAX_BYTES
        };
        if file.size_bytes > limit {
            return Err(if purpose == "preview" {
                DeliveryError::PreviewUnavailable
            } else {
                DeliveryError::Unavailable
            });
        }
        let content = self
            .blobs
            .get(&file.storage_reference, file.size_bytes, 30_000)
            .await
            .map_err(|_| DeliveryError::Unavailable)?
            .ok_or(DeliveryError::Unavailable)?;
        if content.len() != file.size_bytes || checksum(&content) != file.checksum {
            return Err(DeliveryError::Unavailable);
        }
        let current = self.metadata(a, target).await?;
        if current.storage_reference != file.storage_reference
            || current.checksum != file.checksum
            || current.size_bytes != file.size_bytes
        {
            return Err(DeliveryError::Unavailable);
        }
        grants::verify(&self.secret, token, a, target, purpose, (self.now)())?;
        Ok((file, content))
    }
}
