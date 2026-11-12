use crate::{
    auth,
    documents::{Payload, document_context},
    issues::IssueHttpError,
    state::AppState,
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use forge_store::{
    StoreError,
    loops::{DispatchOptions, DispatchReport, Options, Service},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use subtle::ConstantTimeEq;
fn service(state: &AppState) -> Result<Service, StoreError> {
    let mut service = Service::new(
        state.pool.clone().ok_or(StoreError::Unauthenticated)?,
        state.loops.clone().unwrap_or_else(Options::from_env),
    );
    service.agents = state
        .agents
        .as_ref()
        .map(|a| Arc::new(a.coordinator.clone()));
    Ok(service)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    team_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Write {
    team_id: String,
    command_key: String,
    command: Value,
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (_, actor, input) = document_context(&state, &headers, payload).await?;
    let input: Read = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(service(&state)?.read(&actor, &input.team_id).await?))
}
pub(crate) async fn write(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (_, actor, input) = document_context(&state, &headers, payload).await?;
    let input: Write = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        service(&state)?
            .command(&actor, &input.team_id, &input.command_key, input.command)
            .await?,
    ))
}
fn response(status: StatusCode, body: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}
fn error(status: StatusCode, message: &str) -> Response {
    response(status, json!({"error":message}))
}
/// Keep scheduler authentication ahead of database and provider construction.
/// The returned receipt is emitted only after the worker's settlement completes.
pub async fn handle_scheduler<F, Fut>(request: Request, options: &Options, run: F) -> Response
where
    F: FnOnce(i64) -> Fut,
    Fut: Future<Output = Result<DispatchReport, StoreError>>,
{
    let start_before = chrono::Utc::now()
        .timestamp_millis()
        .saturating_add(forge_core::loops::SCHEDULER_SETUP_MS);
    if !matches!(*request.method(), Method::GET | Method::POST) {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::CACHE_CONTROL, "no-store")],
        )
            .into_response();
    }
    let secret = options
        .environment
        .get("CRON_SECRET")
        .map(String::as_str)
        .unwrap_or("");
    let credentials = request.headers().get_all(header::AUTHORIZATION);
    let supplied = credentials
        .iter()
        .next()
        .map(|h| h.as_bytes())
        .unwrap_or_default();
    let supplied = supplied.strip_prefix(b"Bearer ").unwrap_or(supplied);
    if credentials.iter().count() != 1
        || secret.encode_utf16().count() < 32
        || supplied.len() != secret.len()
        || !bool::from(supplied.ct_eq(secret.as_bytes()))
    {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CACHE_CONTROL, "no-store")],
        )
            .into_response();
    }
    if !options.enabled {
        return response(StatusCode::OK, json!(DispatchReport::default()));
    }
    match run(start_before).await {
        Ok(report) => response(StatusCode::OK, json!(report)),
        Err(_) => response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"code":"LOOP_DISPATCH_FAILED"}),
        ),
    }
}
pub(crate) async fn scheduler(State(state): State<AppState>, request: Request) -> Response {
    let options = state.loops.clone().unwrap_or_else(Options::from_env);
    handle_scheduler(request, &options, |start_before| async move {
        service(&state)?
            .dispatch(DispatchOptions {
                limit: 1,
                execution_start_before: Some(start_before),
                ..Default::default()
            })
            .await
    })
    .await
}
pub(crate) async fn webhook(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if request.method() != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let unavailable = || error(StatusCode::NOT_FOUND, "Webhook unavailable");
    let Ok(service) = service(&state) else {
        return unavailable();
    };
    if !service.options.enabled || !forge_core::text::is_uuid(&id) {
        return unavailable();
    }
    let (parts, body) = request.into_parts();
    let header_value = |key: &str| parts.headers.get(key).and_then(|v| v.to_str().ok());
    let Some(token) = header_value("authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| {
            (40..=100).contains(&s.len())
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
        .map(str::to_owned)
    else {
        return unavailable();
    };
    let Some(key) = header_value("webhook-id")
        .map(forge_core::text::trim)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 200)
        .map(str::to_owned)
    else {
        return error(StatusCode::BAD_REQUEST, "A unique Webhook-Id is required");
    };
    if !header_value("content-type")
        .is_some_and(|s| s.to_lowercase().starts_with("application/json"))
    {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "JSON required");
    }
    if header_value("content-length")
        .and_then(|s| s.parse::<f64>().ok())
        .is_some_and(|n| n > 131072.)
    {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
    }
    let Ok(bytes) = to_bytes(body, 131072).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
    };
    let text = String::from_utf8_lossy(&bytes);
    // TextDecoder in the source consumes one leading UTF-8 byte-order mark.
    let Ok(body) = forge_core::json::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid JSON");
    };
    match service.webhook(&id, &token, &key, body).await {
        Ok(Some(id)) => response(StatusCode::ACCEPTED, json!({"accepted":true,"runId":id})),
        Ok(None) => unavailable(),
        Err(StoreError::LoopPolicy(_)) => error(
            StatusCode::CONFLICT,
            "Event identity already used with different input",
        ),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Webhook receipt could not be confirmed. Retry with the same Webhook-Id.",
        ),
    }
}
