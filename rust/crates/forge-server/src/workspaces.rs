use crate::{
    auth::{AuthError, configuration, cookie_token, invalid_body, unavailable},
    state::AppState,
};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
};
use forge_store::{StoreError, authority, workspaces};
use serde::Deserialize;
use serde_json::{Value, json};

fn body<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, AuthError> {
    payload.map(|Json(value)| value).map_err(|_| invalid_body())
}

fn slug_valid(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 255
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Deserialize)]
pub(crate) struct Create {
    name: String,
    slug: String,
    logo: Option<String>,
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<Create>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    if input.name.trim().is_empty() || !slug_valid(&input.slug) {
        return Err(invalid_body());
    }
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    Ok(Json(
        serde_json::to_value(
            workspaces::create(
                pool,
                &token,
                &input.name,
                &input.slug,
                input.logo.as_deref(),
            )
            .await?,
        )
        .map_err(|_| unavailable())?,
    ))
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    Ok(Json(
        serde_json::to_value(workspaces::list(pool, &token).await?).map_err(|_| unavailable())?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct CheckSlug {
    slug: String,
}

pub(crate) async fn check_slug(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CheckSlug>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    if !slug_valid(&input.slug) {
        return Err(invalid_body());
    }
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    Ok(Json(
        json!({"status":workspaces::slug_available(pool,&token,&input.slug).await?}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetActive {
    organization_id: Option<String>,
    organization_slug: Option<String>,
}

pub(crate) async fn set_active(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SetActive>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    let id = if let Some(id) = input.organization_id {
        Some(id)
    } else if let Some(slug) = input.organization_slug {
        Some(
            workspaces::list(pool, &token)
                .await?
                .into_iter()
                .find(|workspace| workspace.slug == slug)
                .ok_or(StoreError::Forbidden)?
                .id,
        )
    } else {
        None
    };
    Ok(Json(
        serde_json::to_value(workspaces::set_active(pool, &token, id.as_deref()).await?)
            .map_err(|_| unavailable())?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Update {
    organization_id: Option<String>,
    data: Value,
}

pub(crate) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<Update>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let data = input.data.as_object().ok_or_else(invalid_body)?;
    if data.is_empty()
        || data
            .keys()
            .any(|key| !["name", "slug", "logo"].contains(&key.as_str()))
    {
        return Err(invalid_body());
    }
    let name = data
        .get("name")
        .map(|value| {
            value
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .ok_or_else(invalid_body)
        })
        .transpose()?;
    let slug = data
        .get("slug")
        .map(|value| {
            value
                .as_str()
                .filter(|slug| slug_valid(slug))
                .ok_or_else(invalid_body)
        })
        .transpose()?;
    let logo = data
        .get("logo")
        .map(|value| {
            if value.is_null() {
                Ok(None)
            } else {
                value.as_str().map(Some).ok_or_else(invalid_body)
            }
        })
        .transpose()?;
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    let id = match input.organization_id {
        Some(id) => id,
        None => authority::session_actor(pool, &token).await?.workspace_id,
    };
    Ok(Json(
        serde_json::to_value(workspaces::update(pool, &token, &id, name, slug, logo).await?)
            .map_err(|_| unavailable())?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Delete {
    organization_id: String,
}

pub(crate) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<Delete>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    workspaces::delete(pool, &token, &input.organization_id).await?;
    Ok(Json(json!({"id":input.organization_id})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcceptInvitation {
    invitation_id: String,
}

pub(crate) async fn accept_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<AcceptInvitation>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    let invitation = workspaces::accept_invitation(pool, &token, &input.invitation_id).await?;
    Ok(Json(json!({"invitation":invitation})))
}
