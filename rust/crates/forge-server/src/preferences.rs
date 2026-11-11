use crate::{
    auth::{self, configuration, cookie_token},
    issues::{IssueHttpError, Payload},
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::HeaderMap,
};
use forge_core::actor::Actor;
use forge_store::{
    Database, StoreError, authority,
    preferences::{self, PreferenceOptions},
};
use serde::Deserialize;
use serde_json::{Value, json};
async fn actor<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> Result<(&'a Database, Actor, PreferenceOptions), IssueHttpError> {
    let (db, config) = configuration(state)?;
    let a = authority::session_actor(db, &cookie_token(headers, config)?).await?;
    let options = PreferenceOptions::from_env(&a);
    Ok((db, a, options))
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Read {
    scope: Option<String>,
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Read>,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, options) = actor(&state, &headers).await?;
    let scope = query.scope.as_deref().unwrap_or("account");
    if !["account", "workspace"].contains(&scope) {
        return Err(StoreError::InvalidInput.into());
    }
    if !options.enabled {
        return Ok(Json(json!({"status":"disabled"})));
    }
    Ok(Json(
        json!({"status":"ready","snapshot":preferences::read(db,&a,scope,options).await?}),
    ))
}
pub(crate) async fn patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, a, options) = actor(&state, &headers).await?;
    Ok(Json(preferences::patch(db, &a, input, options).await?))
}
pub(crate) async fn directory(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let o = input.as_object().ok_or_else(auth::invalid_body)?;
    if o.len() != 2 {
        return Err(auth::invalid_body().into());
    }
    let workspace = o
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(auth::invalid_body)?;
    let session = o
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(auth::invalid_body)?;
    let (db, a, options) = actor(&state, &headers).await?;
    Ok(Json(
        preferences::directory(db, &a, workspace, session, options).await?,
    ))
}
pub(crate) async fn imports(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, a, options) = actor(&state, &headers).await?;
    Ok(Json(
        preferences::imports::load(db, &a, input, options).await?,
    ))
}
pub(crate) async fn prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, a, options) = actor(&state, &headers).await?;
    Ok(Json(
        preferences::imports::prepare(db, &a, input, options).await?,
    ))
}
pub(crate) async fn apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, a, options) = actor(&state, &headers).await?;
    Ok(Json(
        preferences::imports::apply(db, &a, input, options).await?,
    ))
}
