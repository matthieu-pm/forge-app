//! Private, conversation-owned sandbox continuation. Only a leased engine may
//! open its journaled key. Resource handles and credentials are never serialized.
use crate::{
    Result,
    sandbox::{Execution, Sandbox, Workspace},
    vercel,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reference {
    pub key: Uuid,
    pub provisioned: bool,
}
impl Reference {
    pub fn new() -> Self {
        Self {
            key: Uuid::new_v4(),
            provisioned: false,
        }
    }
    pub fn identity(&self) -> String {
        identity(self.key)
    }
}
fn identity(key: Uuid) -> String {
    format!("native-workspace:{key}")
}
#[async_trait]
pub trait Factory: Send + Sync {
    /// The owner persists `key` before this call, then acknowledges provisioning
    /// in the same journal before any model-authored workspace operation.
    async fn open(&self, key: Uuid, create_if_missing: bool) -> Result<Arc<dyn Workspace>>;
}
pub struct VercelFactory {
    pub factory: Arc<vercel::Factory>,
    pub snapshot_retention_ms: u64,
}
#[async_trait]
impl Factory for VercelFactory {
    async fn open(&self, key: Uuid, create_if_missing: bool) -> Result<Arc<dyn Workspace>> {
        let sandbox = self
            .factory
            .open_workspace(vercel::WorkspaceOptions {
                key,
                create_if_missing,
                snapshot_retention_ms: self.snapshot_retention_ms,
            })
            .await?;
        Ok(Arc::new(Named {
            identity: identity(key),
            sandbox,
        }))
    }
}
struct Named {
    identity: String,
    sandbox: Arc<vercel::VercelSandbox>,
}
#[async_trait]
impl Sandbox for Named {
    async fn write(&self, path: &str, content: &str) -> Result<()> {
        self.sandbox.write(path, content).await
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        self.sandbox.run(command).await
    }
    async fn remove(&self, path: &str) -> Result<()> {
        self.sandbox.remove(path).await
    }
}
#[async_trait]
impl Workspace for Named {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn is_usable(&self) -> bool {
        self.sandbox.is_usable()
    }
    async fn read_text(&self, path: &str) -> Result<Option<String>> {
        self.sandbox.read_text(path).await
    }
    async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        self.sandbox.write_text(path, content).await
    }
}
