//! Meeting provider transport. Production endpoints come exclusively from the
//! source-compatible configuration; redirects and provider error bodies never
//! cross the credential boundary. Tests inject transport, not live endpoints.
use async_trait::async_trait;
use forge_core::calls::providers::{self, Config, Error, Exchange, Gateway, TokenRequest, Tokens};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
#[async_trait]
pub trait Transport: Send + Sync {
    async fn exchange(&self, request: TokenRequest) -> Result<Value, Error>;
}
pub struct HttpTransport(reqwest::Client);
impl HttpTransport {
    pub fn new() -> Result<Self, Error> {
        Ok(Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| Error)?,
        ))
    }
}
#[async_trait]
impl Transport for HttpTransport {
    async fn exchange(&self, request: TokenRequest) -> Result<Value, Error> {
        // Defense in depth: this public adapter never posts secrets elsewhere,
        // even if called without Config's fixed-endpoint request builder.
        if ![
            "https://oauth2.googleapis.com/token",
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
            "https://zoom.us/oauth/token",
        ]
        .contains(&request.url.as_str())
        {
            return Err(Error);
        }
        let mut builder = self.0.post(&request.url).form(&request.form);
        for (key, value) in request.headers {
            builder = builder.header(key, value);
        }
        let mut response = builder.send().await.map_err(|_| Error)?;
        if !response.status().is_success() {
            return Err(Error);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error)? {
            if bytes.len() + chunk.len() > 6_000_000 {
                return Err(Error);
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes);
        if text.encode_utf16().count() > 2_000_000 {
            return Err(Error);
        }
        serde_json::from_str(&text).map_err(|_| Error)
    }
}
pub struct Client {
    pub environment: HashMap<String, String>,
    pub transport: Arc<dyn Transport>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Client {
    pub fn new(environment: HashMap<String, String>, transport: Arc<dyn Transport>) -> Self {
        Self {
            environment,
            transport,
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        }
    }
}
#[async_trait]
impl Gateway for Client {
    fn authorization_url(
        &self,
        provider: &str,
        state: &str,
        challenge: &str,
    ) -> Result<String, Error> {
        Ok(Config::new(&self.environment, provider)?.authorization_url(state, challenge))
    }
    async fn exchange(&self, provider: &str, input: Exchange<'_>) -> Result<Tokens, Error> {
        let config = Config::new(&self.environment, provider)?;
        let response = self.transport.exchange(config.request(&input)).await?;
        providers::tokens(response, &input, (self.now)())
    }
}
#[derive(Clone)]
pub struct Settings {
    pub options: forge_store::calls::Options,
    pub gateway: Arc<dyn Gateway>,
    pub vault: Option<Arc<dyn forge_store::agents::model_connections::Vault>>,
}
impl Settings {
    pub fn configured(environment: &HashMap<String, String>) -> Result<Self, &'static str> {
        let vault = environment
            .get("FORGE_MODEL_CREDENTIAL_KEK")
            .filter(|s| !s.is_empty())
            .and_then(|key| forge_identity::model_vault::Vault::new(key).ok())
            .map(|v| Arc::new(v) as Arc<dyn forge_store::agents::model_connections::Vault>);
        Ok(Self {
            options: forge_store::calls::Options {
                environment: environment.clone(),
            },
            gateway: Arc::new(Client::new(
                environment.clone(),
                Arc::new(
                    HttpTransport::new()
                        .map_err(|_| "Meeting provider transport is unavailable.")?,
                ),
            )),
            vault,
        })
    }
    pub fn service(&self, database: forge_store::Database) -> forge_store::calls::Service {
        let mut service = forge_store::calls::Service::new(database, self.options.clone());
        service.gateway = Some(self.gateway.clone());
        service.vault = self.vault.clone();
        service
    }
}
