use crate::{
    auth,
    issues::{IssueHttpError, Payload, context},
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_store::{
    saved_views::{self, ViewOptions},
    team_resources::{self, ResourceOptions},
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;
fn identity(s: &str) -> Result<Uuid, IssueHttpError> {
    if !forge_core::text::is_uuid(s) {
        return Err(auth::invalid_body().into());
    }
    s.parse().map_err(|_| auth::invalid_body().into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Team {
    team_id: String,
}
pub(crate) async fn resources(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Team = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        team_resources::read(
            db,
            &a,
            identity(&input.team_id)?,
            ResourceOptions::from_env(),
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Board {
    command_key: String,
    command: Value,
}
pub(crate) async fn save_resources(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Board = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        team_resources::command(
            db,
            &a,
            &input.command_key,
            input.command,
            ResourceOptions::from_env(),
        )
        .await?,
    ))
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    if input.as_object().is_none_or(|o| !o.is_empty()) {
        return Err(auth::invalid_body().into());
    }
    Ok(Json(
        saved_views::read(db, &a, ViewOptions::from_env()).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mutation {
    command_key: String,
    mutation: Value,
}
pub(crate) async fn mutate(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Mutation = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    identity(&input.command_key)?;
    Ok(Json(
        saved_views::mutate(
            db,
            &a,
            &input.command_key,
            input.mutation,
            ViewOptions::from_env(),
        )
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    definition: Value,
}
pub(crate) async fn query(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, input) = context(&state, &headers, payload).await?;
    let input: Query = serde_json::from_value(input).map_err(|_| auth::invalid_body())?;
    Ok(Json(
        saved_views::query_projects(db, &a, input.definition, ViewOptions::from_env()).await?,
    ))
}
