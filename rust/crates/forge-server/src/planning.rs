use crate::{
    auth::{self, configuration, cookie_token},
    issues::{IssueHttpError, Payload, context},
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_store::{
    authority,
    initiatives::{self, InitiativeOptions},
    planning::{self, Relation, Resource},
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;
pub(crate) async fn initiatives(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, auth) = configuration(&state)?;
    let a = authority::session_actor(db, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        initiatives::read(db, &a, InitiativeOptions::from_env()).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    command_key: String,
    changes: Value,
}
pub(crate) async fn save_initiatives(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Save = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        initiatives::save(
            db,
            &a,
            &input.command_key,
            input.changes,
            InitiativeOptions::from_env(),
        )
        .await?,
    ))
}
pub(crate) async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, auth) = configuration(&state)?;
    let a = authority::session_actor(db, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        initiatives::read_settings(db, &a, InitiativeOptions::from_env()).await?,
    ))
}
pub(crate) async fn save_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    Ok(Json(initiatives::save_settings(db, &a, input).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    kind: Resource,
    query: Value,
}
pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Page = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(planning::list(db, &a, input.kind, input.query).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    kind: Resource,
    #[serde(deserialize_with = "identity")]
    id: Uuid,
}
pub(crate) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Identity = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(planning::get(db, &a, input.kind, input.id).await?))
}
pub(crate) async fn rollup(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Identity = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(planning::rollup(db, &a, input.kind, input.id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Link {
    kind: Relation,
    #[serde(deserialize_with = "identity")]
    id: Uuid,
}
pub(crate) async fn related(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Link = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(planning::related(db, &a, input.kind, input.id).await?))
}

fn identity<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Uuid, D::Error> {
    let s = String::deserialize(d)?;
    if !forge_core::text::is_uuid(&s) {
        return Err(serde::de::Error::custom("UUID"));
    }
    s.parse().map_err(serde::de::Error::custom)
}
