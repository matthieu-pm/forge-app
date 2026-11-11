use crate::{
    auth::{self, configuration, cookie_token},
    issues::{IssueHttpError, Payload, context},
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_store::{authority, projects};
use serde::Deserialize;
use serde_json::Value;
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, auth) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, auth)?).await?;
    Ok(Json(projects::read(db, &actor).await?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    command_key: String,
    changes: Value,
}
pub(crate) async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, actor, input) = context(&state, &headers, payload).await?;
    let input: Save = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        projects::save(db, &actor, &input.command_key, input.changes).await?,
    ))
}
pub(crate) async fn catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, auth) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, auth)?).await?;
    Ok(Json(projects::read_catalog(db, &actor).await?))
}
pub(crate) async fn save_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, actor, input) = context(&state, &headers, payload).await?;
    Ok(Json(projects::save_catalog(db, &actor, input).await?))
}
