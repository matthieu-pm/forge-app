use crate::{
    auth,
    issues::{IssueHttpError, context},
    state::AppState,
};
use axum::{
    Json,
    body::Bytes,
    extract::{State, rejection::BytesRejection},
    http::{HeaderMap, header},
};
use forge_store::documents::{self, DocumentOptions};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

// A valid 64-node document can exceed serde_json's default 128 JSON containers.
// The route bounds bytes; this parser separately bounds container nesting.
pub(crate) type Payload = Result<Bytes, BytesRejection>;
pub(crate) async fn document_context<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    payload: Payload,
) -> Result<(&'a forge_store::Database, forge_core::actor::Actor, Value), IssueHttpError> {
    let media = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !(media == "application/json"
        || (media.starts_with("application/") && media.ends_with("+json")))
    {
        return Err(auth::invalid_body().into());
    }
    let bytes = payload.map_err(|_| auth::invalid_body())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| auth::invalid_body())?;
    let value = forge_core::json::parse(text).map_err(|_| auth::invalid_body())?;
    context(state, headers, Ok(Json(value))).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    source: Option<Value>,
    id: Option<String>,
}
fn id(raw: &str) -> Result<Uuid, IssueHttpError> {
    if !forge_core::text::is_uuid(raw) {
        return Err(auth::invalid_body().into());
    }
    raw.parse().map_err(|_| auth::invalid_body().into())
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = document_context(&state, &headers, payload).await?;
    let input: Read = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        documents::read(
            db,
            &a,
            input.source,
            input.id.as_deref().map(id).transpose()?,
            DocumentOptions::from_env(),
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Write {
    command_key: String,
    command: Value,
}
pub(crate) async fn write(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = document_context(&state, &headers, payload).await?;
    let input: Write = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        documents::command(
            db,
            &a,
            &input.command_key,
            input.command,
            DocumentOptions::from_env(),
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    id: String,
    before: Option<i64>,
}
pub(crate) async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = document_context(&state, &headers, payload).await?;
    let input: History = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        documents::history(
            db,
            &a,
            id(&input.id)?,
            input.before,
            DocumentOptions::from_env(),
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sharing {
    id: String,
    shared: bool,
}
pub(crate) async fn share(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = document_context(&state, &headers, payload).await?;
    let input: Sharing = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        documents::share(
            db,
            &a,
            id(&input.id)?,
            input.shared,
            DocumentOptions::from_env(),
        )
        .await?,
    ))
}
