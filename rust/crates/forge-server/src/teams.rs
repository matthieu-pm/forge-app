use crate::{
    auth::{AuthError, configuration, cookie_token, invalid_body},
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::HeaderMap,
};
use forge_core::teams::{CreateTeam, TeamSettings};
use forge_store::{
    StoreError, authority,
    teams::{self, Selector},
};
use serde::Deserialize;
use serde_json::{Value, json};

fn body<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, AuthError> {
    payload.map(|Json(v)| v).map_err(|_| invalid_body())
}
fn result(value: Result<Value, StoreError>) -> Result<Json<Value>, AuthError> {
    match value {
        Ok(value) => {
            let mut result = json!({"ok":true});
            if let Some(object) = value.as_object() {
                for (k, v) in object {
                    result[k] = v.clone();
                }
            }
            Ok(Json(result))
        }
        Err(StoreError::Team(error)) => {
            let mut value = json!({"ok":false,"code":error.code(),"message":error.to_string()});
            if let Some(field) = error.field() {
                value["field"] = json!(field);
            }
            Ok(Json(value))
        }
        Err(StoreError::Forbidden) => Ok(Json(
            json!({"ok":false,"code":"FORBIDDEN","message":"You do not have permission to perform this action."}),
        )),
        Err(error) => Err(error.into()),
    }
}
pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = CreateTeam::parse(body(payload)?).map_err(|_| invalid_body())?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    result(
        teams::create(database, &actor, &input)
            .await
            .map(|team| json!({"team":team})),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    cursor: Option<String>,
    limit: Option<i64>,
}
pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<Page>,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        teams::list(
            database,
            &actor,
            input.cursor.as_deref(),
            input.limit.unwrap_or(100),
        )
        .await?,
    ))
}
pub(crate) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(json!(
        teams::get(
            database,
            &actor,
            &Selector::Slug(forge_core::text::trim(&slug).to_lowercase())
        )
        .await?
    )))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Update {
    settings: Value,
}
pub(crate) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    payload: Result<Json<Update>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = TeamSettings::parse(body(payload)?.settings).map_err(|_| invalid_body())?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    result(
        teams::update(database, &actor, &Selector::Slug(slug), &input)
            .await
            .map(|team| json!({"team":team})),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Archive {
    confirmation_name: String,
}
pub(crate) async fn archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    payload: Result<Json<Archive>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let name = forge_core::text::trim(&input.confirmation_name);
    if name.is_empty() || forge_core::text::length(name) > 80 {
        return Err(invalid_body());
    }
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    result(teams::archive(database, &actor, &Selector::Slug(slug), Some(name)).await)
}
pub(crate) async fn restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    result(
        teams::restore(database, &actor, &Selector::Slug(slug))
            .await
            .map(|team| json!({"team":team})),
    )
}
pub(crate) async fn join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AuthError> {
    membership(&state, &headers, slug, false).await
}
pub(crate) async fn leave(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AuthError> {
    membership(&state, &headers, slug, true).await
}
async fn membership(
    state: &AppState,
    headers: &HeaderMap,
    slug: String,
    leaving: bool,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(state)?;
    let actor = authority::session_actor(database, &cookie_token(headers, auth)?).await?;
    result(teams::join(database, &actor, &Selector::Slug(slug), leaving).await)
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Lifecycle {
    #[default]
    Active,
    Archived,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Directory {
    #[serde(default)]
    lifecycle: Lifecycle,
}
pub(crate) async fn directory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<Directory>,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        teams::directory(
            database,
            &actor,
            matches!(input.lifecycle, Lifecycle::Archived),
        )
        .await?,
    ))
}
pub(crate) async fn members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        teams::member_directory(database, &actor, &Selector::Slug(slug)).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AddMembers {
    user_ids: Vec<String>,
}
pub(crate) async fn add_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    payload: Result<Json<AddMembers>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    result(
        teams::add_members(database, &actor, &Selector::Slug(slug), &input.user_ids)
            .await
            .map(|_| json!({})),
    )
}
