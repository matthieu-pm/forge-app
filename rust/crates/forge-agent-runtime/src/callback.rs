use crate::{Error, Result, auth::Channel};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use url::Url;

#[derive(Clone)]
pub struct Request {
    pub id: String,
    pub version: String,
    pub input: Value,
    pub idempotency_key: Option<String>,
}
#[async_trait]
pub trait Capabilities: Send + Sync {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value>;
}
#[async_trait]
pub trait PeerIdentity: Send + Sync {
    async fn token(&self) -> Result<String>;
}

pub struct HttpCapabilities {
    origin: Url,
    peer: Option<(Url, Arc<dyn PeerIdentity>)>,
    client: reqwest::Client,
}
const FAILED: Error = Error("Forge capability request failed.");
impl HttpCapabilities {
    /// Origins come from reviewed deployment configuration, never tool input.
    pub fn new(origin: Url, peer: Option<(Url, Arc<dyn PeerIdentity>)>) -> Result<Self> {
        if !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err(FAILED);
        }
        if peer
            .as_ref()
            .is_some_and(|(p, _)| p.origin() != origin.origin())
        {
            return Err(FAILED);
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| FAILED)?;
        Ok(Self {
            origin,
            peer,
            client,
        })
    }
}
#[async_trait]
impl Capabilities for HttpCapabilities {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value> {
        if request.id.is_empty() || request.version.is_empty() || !request.input.is_object() {
            return Err(FAILED);
        }
        let mut target = self.origin.clone();
        target.set_path("/api/agent/capabilities/");
        target.set_query(None);
        target.set_fragment(None);
        target
            .path_segments_mut()
            .map_err(|_| FAILED)?
            .pop_if_empty()
            .push(&request.id);
        // Credential acquisition happens only after the exact peer origin check.
        let identity = if let Some((peer, identity)) = &self.peer {
            if peer.origin() != target.origin() {
                return Err(FAILED);
            }
            Some(
                tokio::time::timeout(Duration::from_secs(10), identity.token())
                    .await
                    .map_err(|_| FAILED)?
                    .map_err(|_| FAILED)?,
            )
        } else {
            None
        };
        let mut body = json!({"version":request.version,"input":request.input});
        if let Some(key) = request.idempotency_key {
            body["idempotencyKey"] = json!(key);
        }
        let mut req = self
            .client
            .post(target)
            .bearer_auth(channel.capability_token())
            .header("x-correlation-id", channel.correlation_id())
            .header("x-forge-agent-run-id", channel.run_id())
            .header("x-forge-workspace-id", channel.workspace_id())
            .json(&body);
        if let Some(identity) = identity {
            req = req.header("x-vercel-trusted-oidc-idp-token", identity);
        }
        let mut response = req.send().await.map_err(|_| FAILED)?;
        if !response.status().is_success() {
            return Err(FAILED);
        }
        const LIMIT: usize = 4 * 1024 * 1024;
        if response.content_length().is_some_and(|l| l > LIMIT as u64) {
            return Err(FAILED);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
            if bytes.len() + chunk.len() > LIMIT {
                return Err(FAILED);
            }
            bytes.extend_from_slice(&chunk);
        }
        forge_core::json::parse(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}'))
            .map_err(|_| FAILED)
    }
}
