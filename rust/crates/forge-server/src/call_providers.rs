//! Meeting provider transport. Production endpoints come exclusively from the
//! source-compatible configuration; redirects and provider error bodies never
//! cross the credential boundary. Tests inject transport, not live endpoints.
use async_trait::async_trait;
use forge_core::calls::providers::{self, Config, Error, Exchange, Gateway, TokenRequest, Tokens};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
mod native;
/// A scheduled sync always attempts recap generation. Validate the complete
/// capability before opening the operator's explicitly selected database.
pub fn validate_operator(env: &HashMap<String, String>) -> Result<(), &'static str> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let invalid = "INVALID_CONFIGURATION";
    crate::operator::database_url(env)?;
    forge_core::deployment::validate(env, "web").map_err(|_| invalid)?;
    if !["", "true"].contains(
        &env.get("FORGE_CALLS_ENABLED")
            .map(String::as_str)
            .unwrap_or(""),
    ) {
        return Err(invalid);
    }
    let selected = forge_core::calls::selected_providers(env);
    if selected.is_empty() {
        return Err(invalid);
    }
    let required = |key: &str| {
        env.get(key)
            .filter(|s| !forge_core::text::trim(s).is_empty())
            .ok_or(invalid)
    };
    for provider in selected {
        let config = Config::new(env, &provider).map_err(|_| invalid)?;
        if forge_core::text::trim(&config.client_id).is_empty()
            || forge_core::text::trim(&config.client_secret).is_empty()
        {
            return Err(invalid);
        }
    }
    required("OPENAI_API_KEY")?;
    let key = required("FORGE_MODEL_CREDENTIAL_KEK")?;
    let bytes = STANDARD.decode(key).map_err(|_| invalid)?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != *key {
        return Err(invalid);
    }
    let origin = url::Url::parse(required("BETTER_AUTH_URL")?).map_err(|_| invalid)?;
    let secure = env
        .get("FORGE_ENVIRONMENT")
        .is_none_or(|s| s != "development");
    if !(origin.scheme() == "https" || !secure && origin.scheme() == "http")
        || secure && ["localhost", "127.0.0.1", "[::1]"].contains(&origin.host_str().unwrap_or(""))
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(invalid);
    }
    Ok(())
}
#[async_trait]
pub trait Transport: Send + Sync {
    async fn exchange(&self, request: TokenRequest) -> Result<Value, Error>;
    async fn read(&self, _url: &str, _token: &str) -> Result<String, Error> {
        Err(Error)
    }
    async fn summary(&self, _key: &str, _request: Value) -> Result<Value, Error> {
        Err(Error)
    }
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
    async fn read(&self, url: &str, token: &str) -> Result<String, Error> {
        if !native::allowed(url) {
            return Err(Error);
        }
        response_text(
            self.0
                .get(url)
                .bearer_auth(token)
                .header("Prefer", "outlook.timezone=\"UTC\"")
                .send()
                .await
                .map_err(|_| Error)?,
        )
        .await
    }
    async fn summary(&self, key: &str, request: Value) -> Result<Value, Error> {
        let response = self
            .0
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(key)
            .timeout(Duration::from_secs(90))
            .json(&request)
            .send()
            .await
            .map_err(|_| Error)?;
        serde_json::from_str(&response_text(response).await?).map_err(|_| Error)
    }
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
        let response = builder.send().await.map_err(|_| Error)?;
        serde_json::from_str(&response_text(response).await?).map_err(|_| Error)
    }
}
async fn response_text(mut response: reqwest::Response) -> Result<String, Error> {
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
    Ok(text.into_owned())
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
    async fn native_calls(
        &self,
        provider: &str,
        token: &str,
        since: chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<providers::NativeCall>, Error> {
        Config::new(&self.environment, provider)?;
        let now = chrono::DateTime::from_timestamp_millis((self.now)()).ok_or(Error)?;
        native::fetch(self, provider, token, since, now).await
    }
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
#[async_trait]
impl providers::Summarizer for Client {
    async fn summarize(&self, text: &str) -> Result<Value, Error> {
        forge_core::deployment::validate(&self.environment, "web").map_err(|_| Error)?;
        let key = self
            .environment
            .get("OPENAI_API_KEY")
            .filter(|s| !s.is_empty())
            .ok_or(Error)?;
        let response = self
            .transport
            .summary(key, providers::summary_request(&self.environment, text)?)
            .await?;
        providers::summary_response(response)
    }
}
#[derive(Clone)]
pub struct Settings {
    pub options: forge_store::calls::Options,
    pub gateway: Arc<dyn Gateway>,
    pub vault: Option<Arc<dyn forge_store::agents::model_connections::Vault>>,
    pub summarizer: Option<Arc<dyn providers::Summarizer>>,
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
            summarizer: Some(Arc::new(Client::new(
                environment.clone(),
                Arc::new(
                    HttpTransport::new().map_err(|_| "Call summary transport is unavailable.")?,
                ),
            ))),
        })
    }
    pub fn service(&self, database: forge_store::Database) -> forge_store::calls::Service {
        let mut service = forge_store::calls::Service::new(database, self.options.clone());
        service.gateway = Some(self.gateway.clone());
        service.vault = self.vault.clone();
        service.summarizer = self.summarizer.clone();
        service
    }
}
