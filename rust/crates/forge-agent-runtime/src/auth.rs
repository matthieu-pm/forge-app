use crate::{Error, Result};
use forge_core::agents::tokens::{self, Kind};
use serde_json::Value;

/// Server-only credentials. Deliberately no Debug or Serialize implementation.
#[derive(Clone)]
pub struct Channel(Value);
impl Channel {
    pub fn verify(secret: &str, authorization: &str, now: i64) -> Result<Self> {
        let token = authorization
            .strip_prefix("Bearer ")
            .map(forge_core::text::trim)
            .filter(|s| !s.is_empty() && s.len() <= 32768)
            .ok_or(Error("Unauthorized runtime request."))?;
        tokens::verify(secret, Kind::RuntimeChannel, token, now)
            .map(Self)
            .map_err(|_| Error("Unauthorized runtime request."))
    }
    fn field(&self, key: &str) -> &str {
        self.0[key].as_str().unwrap()
    }
    pub fn principal_id(&self) -> &str {
        self.field("sub")
    }
    pub fn workspace_id(&self) -> &str {
        self.field("workspaceId")
    }
    pub fn run_id(&self) -> &str {
        self.field("runId")
    }
    pub fn correlation_id(&self) -> &str {
        self.0["correlationId"].as_str().unwrap_or(self.run_id())
    }
    pub fn provider(&self) -> &str {
        self.field("provider")
    }
    pub fn model_id(&self) -> &str {
        self.field("modelId")
    }
    pub fn reasoning_effort(&self) -> &str {
        self.field("reasoningEffort")
    }
    pub(crate) fn capability_token(&self) -> &str {
        self.field("forgeCapabilityToken")
    }
    pub fn model_access_token(&self) -> &str {
        self.field("forgeModelAccessToken")
    }
}
