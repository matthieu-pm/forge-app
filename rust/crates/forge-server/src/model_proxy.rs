//! Run-scoped provider proxy. Forwarding preserves streaming backpressure and
//! never forwards caller credentials, cookies or unreviewed provider headers.
use super::{model_providers::ProviderDiscovery, state::AppState};
use async_trait::async_trait;
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use forge_core::agents::{
    policy,
    providers::{self, ModelClaims, RuntimeCredential},
    tokens::{self, Kind},
};
use forge_store::{
    StoreError,
    agents::model_connections::{Service, Vault},
};
use std::{collections::HashMap, sync::Arc};
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const SAFE_HEADERS: &[&str] = &[
    "content-type",
    "openai-processing-ms",
    "openai-version",
    "retry-after",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
];
#[async_trait]
pub trait Credentials: Send + Sync {
    async fn load(&self, claims: &ModelClaims) -> Result<Option<RuntimeCredential>, StoreError>;
}
#[async_trait]
pub trait Upstream: Send + Sync {
    async fn send(
        &self,
        credential: RuntimeCredential,
        path: &str,
        accept: &str,
        body: Vec<u8>,
    ) -> Result<Response, StoreError>;
}
struct StoredCredentials {
    service: Service,
    staging: bool,
    features: serde_json::Value,
}
#[async_trait]
impl Credentials for StoredCredentials {
    async fn load(&self, claims: &ModelClaims) -> Result<Option<RuntimeCredential>, StoreError> {
        self.service
            .runtime_credential(claims, self.staging, &self.features)
            .await
    }
}
#[derive(Default)]
pub struct HttpUpstream {
    pub discovery: ProviderDiscovery,
}
#[async_trait]
impl Upstream for HttpUpstream {
    async fn send(
        &self,
        credential: RuntimeCredential,
        path: &str,
        accept: &str,
        body: Vec<u8>,
    ) -> Result<Response, StoreError> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(30));
        let endpoint = if let Some(endpoint) = providers::execution_endpoint(&credential.provider) {
            url::Url::parse(endpoint).map_err(|_| StoreError::InvalidInput)?
        } else {
            let pinned = self
                .discovery
                .endpoint(credential.endpoint_url.as_deref().unwrap_or(""))
                .await?;
            builder = builder.resolve_to_addrs(
                pinned.url.host_str().ok_or(StoreError::InvalidInput)?,
                &pinned.addresses,
            );
            pinned.url
        };
        let mut request = builder
            .build()
            .map_err(|_| StoreError::InvalidInput)?
            .post(endpoint.join(path).map_err(|_| StoreError::InvalidInput)?)
            .header("accept", accept)
            .header("content-type", "application/json")
            .body(body);
        for (name, value) in providers::headers(&credential.provider, &credential.api_key) {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|_| StoreError::InvalidInput)?;
        if [301, 302, 303, 307, 308].contains(&response.status().as_u16())
            && response.headers().contains_key(header::LOCATION)
        {
            return Err(StoreError::InvalidInput);
        }
        let mut output = Response::builder().status(response.status());
        for name in SAFE_HEADERS {
            if let Some(value) = response.headers().get(*name) {
                output = output.header(*name, value);
            }
        }
        // Dropping the downstream body drops this response and its pending read.
        // No detached task continues consuming a cancelled client's generation.
        let stream = futures_util::stream::unfold(Some(response), |state| async move {
            let mut response = state?;
            match response.chunk().await {
                Ok(Some(bytes)) => Some((Ok::<_, std::io::Error>(bytes), Some(response))),
                Ok(None) => None,
                Err(_) => Some((
                    Err(std::io::Error::other(
                        "The provider stream ended unexpectedly.",
                    )),
                    None,
                )),
            }
        });
        output
            .body(Body::from_stream(stream))
            .map_err(|_| StoreError::InvalidInput)
    }
}
pub struct Settings {
    pub secret: String,
    pub enabled: bool,
    pub connections_enabled: bool,
    pub credentials: Arc<dyn Credentials>,
    pub upstream: Arc<dyn Upstream>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}
struct UnavailableVault;
impl Vault for UnavailableVault {
    fn seal(&self, _: &str, _: &str) -> Result<String, providers::Error> {
        Err(providers::Error::new(
            providers::Code::VaultUnavailable,
            "The credential vault is unavailable.",
        ))
    }
    fn open(&self, _: &str, _: &str) -> Result<String, providers::Error> {
        Err(providers::Error::new(
            providers::Code::VaultUnavailable,
            "The credential vault is unavailable.",
        ))
    }
}
impl Settings {
    pub fn configured(database: forge_store::Database, env: &HashMap<String, String>) -> Self {
        let service = configured_connections(database, env);
        let features = policy::features(env);
        Self {
            secret: env
                .get("FORGE_AGENT_MODEL_ACCESS_SECRET")
                .cloned()
                .unwrap_or_default(),
            enabled: features["agent_ui"] == true,
            connections_enabled: features["agent_model_connections"] == true,
            credentials: Arc::new(StoredCredentials {
                service,
                staging: env.get("FORGE_ENVIRONMENT").is_some_and(|v| v == "staging"),
                features,
            }),
            upstream: Arc::new(HttpUpstream::default()),
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        }
    }
}
pub(crate) fn configured_connections(
    database: forge_store::Database,
    env: &HashMap<String, String>,
) -> Service {
    let vault: Arc<dyn Vault> = env
        .get("FORGE_MODEL_CREDENTIAL_KEK")
        .and_then(|v| forge_identity::model_vault::Vault::new(v).ok())
        .map_or_else(
            || Arc::new(UnavailableVault) as Arc<dyn Vault>,
            |v| Arc::new(v),
        );
    let mut service = Service::new(database, Arc::new(ProviderDiscovery::default()), vault);
    let controls = policy::controls(env);
    service.allowed_providers = controls["allowedProviders"].as_array().map(|v| {
        v.iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    });
    service.managed_environment = env
        .iter()
        .filter(|(key, _)| {
            ["OPENAI_API_KEY", "FORGE_MANAGED_OPENAI_MODELS"].contains(&key.as_str())
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    service
}
fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_TYPE, "application/json;charset=utf-8"),
        ],
        Json(serde_json::json!({"error":{"code":code,"message":message}})),
    )
        .into_response()
}
fn failed() -> Response {
    error(
        StatusCode::BAD_GATEWAY,
        "MODEL_PROXY_FAILED",
        "The selected model connection could not complete the request.",
    )
}
fn too_large() -> Response {
    error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "MODEL_REQUEST_TOO_LARGE",
        "The model request exceeds its size limit.",
    )
}
pub async fn handle(request: Request, path: &str, settings: &Settings) -> Response {
    let mut response = handle_inner(request, path, settings).await;
    response.headers_mut().insert(
        "x-request-id",
        uuid::Uuid::new_v4().to_string().parse().unwrap(),
    );
    response
}
async fn handle_inner(request: Request, path: &str, settings: &Settings) -> Response {
    if !settings.enabled {
        return error(
            StatusCode::NOT_FOUND,
            "FEATURE_DISABLED",
            "Forge Agent is not enabled for this deployment.",
        );
    }
    if !settings.connections_enabled {
        return error(
            StatusCode::NOT_FOUND,
            "FEATURE_DISABLED",
            "Model connections are not enabled.",
        );
    }
    if request.method() != Method::POST
        || !["responses", "chat/completions", "messages"].contains(&path)
    {
        return error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MODEL_PROXY_METHOD_NOT_ALLOWED",
            "The model request is not allowed.",
        );
    }
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty() && !v.chars().any(char::is_whitespace));
    let Some(token) = token.filter(|_| {
        request
            .headers()
            .get_all(header::AUTHORIZATION)
            .iter()
            .count()
            == 1
    }) else {
        return error(
            StatusCode::UNAUTHORIZED,
            "MODEL_PROXY_UNAUTHORIZED",
            "A run-scoped model token is required.",
        );
    };
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .is_some_and(|n| n.is_finite() && n > MAX_REQUEST_BYTES as f64)
    {
        return too_large();
    }
    let Ok(claims) = tokens::verify(&settings.secret, Kind::ModelAccess, token, (settings.now)())
        .and_then(|v| serde_json::from_value::<ModelClaims>(v).map_err(|_| tokens::TokenError))
    else {
        return failed();
    };
    let accept = request
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    let body = match to_bytes(request.into_body(), MAX_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return if std::error::Error::source(&error)
                .is_some_and(|e| e.is::<http_body_util::LengthLimitError>())
            {
                too_large()
            } else {
                failed()
            };
        }
    };
    let decoded = String::from_utf8_lossy(&body);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    let Ok(payload) = forge_core::json::parse(text) else {
        return failed();
    };
    if !payload.is_object() || payload["model"] != claims.model_id {
        return error(
            StatusCode::FORBIDDEN,
            "MODEL_BINDING_MISMATCH",
            "The model request does not match this run.",
        );
    }
    let credential = match settings.credentials.load(&claims).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return error(
                StatusCode::FORBIDDEN,
                "MODEL_CONNECTION_UNAVAILABLE",
                "The selected model connection is unavailable.",
            );
        }
        Err(StoreError::Forbidden) => {
            return error(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "The model request was rejected.",
            );
        }
        Err(_) => return failed(),
    };
    let upstream = match settings
        .upstream
        .send(credential, path, &accept, body.to_vec())
        .await
    {
        Ok(response) => response,
        Err(_) => return failed(),
    };
    let (parts, body) = upstream.into_parts();
    let mut response = Response::new(body);
    *response.status_mut() = parts.status;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    for name in SAFE_HEADERS {
        if let Some(value) = parts.headers.get(*name) {
            response.headers_mut().insert(*name, value.clone());
        }
    }
    response
}
pub(crate) async fn route(
    State(state): State<AppState>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    match state.model_proxy.as_deref() {
        Some(settings) => handle(request, &path, settings).await,
        None => error(
            StatusCode::NOT_FOUND,
            "FEATURE_DISABLED",
            "Model connections are not enabled.",
        ),
    }
}
