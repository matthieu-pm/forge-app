//! Model HTTP uses only the app's reviewed proxy and a run-bound credential.
//! Cancellation and the original run deadline cover credential acquisition,
//! network reads and downstream event persistence, with bounded backpressure.
use super::{
    request,
    sse::Decoder,
    stream::{Completion, Delta, Parser},
};
use crate::{Error, Result, auth::Channel, callback::PeerIdentity, sandbox::Cancellation};
use async_trait::async_trait;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::time::{Instant, timeout_at};
use url::Url;

const FAILED: Error = Error("Forge model request failed.");
const CANCELLED: Error = Error("Model generation cancelled.");
const TIMEOUT: Error = Error("Model generation timed out.");

pub struct Turn<'a> {
    pub prompt: &'a [Value],
    pub tools: &'a [Value],
    pub max_output_tokens: Option<u32>,
    pub deadline: Instant,
}
#[async_trait]
pub trait Sink: Send {
    async fn emit(&mut self, delta: Delta) -> Result<()>;
}
#[async_trait]
pub trait Model: Send + Sync {
    async fn generate(
        &self,
        channel: &Channel,
        turn: Turn<'_>,
        cancellation: &Cancellation,
        sink: &mut dyn Sink,
    ) -> Result<Completion>;
}
pub struct HttpModel {
    origin: Url,
    peer: Option<(Url, Arc<dyn PeerIdentity>)>,
    client: reqwest::Client,
}
impl HttpModel {
    pub fn new(origin: Url, peer: Option<(Url, Arc<dyn PeerIdentity>)>) -> Result<Self> {
        if !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || peer
                .as_ref()
                .is_some_and(|(p, _)| p.origin() != origin.origin())
        {
            return Err(FAILED);
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| FAILED)?;
        Ok(Self {
            origin,
            peer,
            client,
        })
    }
    async fn generate_inner(
        &self,
        channel: &Channel,
        turn: &Turn<'_>,
        sink: &mut dyn Sink,
    ) -> Result<Completion> {
        let request = request::build(channel, turn.prompt, turn.tools, turn.max_output_tokens)?;
        let mut target = self.origin.clone();
        target.set_path(&format!(
            "/api/agent/runtime/model/{}",
            request.protocol.path()
        ));
        target.set_query(None);
        target.set_fragment(None);
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
        let mut req = self
            .client
            .post(target)
            .bearer_auth(channel.model_access_token())
            .header("x-correlation-id", channel.correlation_id())
            .header("x-forge-agent-run-id", channel.run_id())
            .header("x-forge-workspace-id", channel.workspace_id())
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(forge_core::canonical::javascript_stringify(&request.body));
        if let Some(identity) = identity {
            req = req.header("x-vercel-trusted-oidc-idp-token", identity);
        }
        let mut response = req.send().await.map_err(|_| FAILED)?;
        if !response.status().is_success()
            || !response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|s| {
                    s.split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .eq_ignore_ascii_case("text/event-stream")
                })
        {
            return Err(FAILED);
        }
        if response
            .content_length()
            .is_some_and(|n| n > 32 * 1024 * 1024)
        {
            return Err(FAILED);
        }
        let mut decoder = Decoder::default();
        let mut parser = Parser::new(request.protocol);
        while let Some(bytes) = response.chunk().await.map_err(|_| FAILED)? {
            for data in decoder.push(&bytes)? {
                for delta in parser.push(&data)? {
                    sink.emit(delta).await?;
                }
            }
        }
        decoder.finish()?;
        parser.finish()
    }
}
#[async_trait]
impl Model for HttpModel {
    async fn generate(
        &self,
        channel: &Channel,
        turn: Turn<'_>,
        cancellation: &Cancellation,
        sink: &mut dyn Sink,
    ) -> Result<Completion> {
        if cancellation.is_cancelled() {
            return Err(CANCELLED);
        }
        if Instant::now() >= turn.deadline {
            return Err(TIMEOUT);
        }
        let result = tokio::select! {
            biased;
            ()=cancellation.cancelled()=>Err(CANCELLED),
            result=timeout_at(turn.deadline,self.generate_inner(channel,&turn,sink))=>result.map_err(|_|TIMEOUT)?,
        }?;
        if cancellation.is_cancelled() {
            return Err(CANCELLED);
        }
        if Instant::now() >= turn.deadline {
            return Err(TIMEOUT);
        }
        Ok(result)
    }
}
