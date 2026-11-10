use crate::{auth::configuration, state::AppState};
use axum::{
    Json,
    body::Body,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{Html, IntoResponse, Response},
};
use forge_core::{
    actor::Actor,
    teams::{CreateTeam, TeamError, TeamSettings},
};
use forge_store::{
    StoreError, authority,
    teams::{self, Selector},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct RequestId(String);

pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    data: Option<Value>,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            data: None,
        }
    }
    fn invalid() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "The request is invalid.",
        )
    }
    fn conflict(error: StoreError, reason: &'static str, field: Option<&'static str>) -> Self {
        let mut value = Self::new(StatusCode::CONFLICT, "CONFLICT", error.to_string());
        let mut data = json!({"reason":reason});
        if let Some(field) = field {
            data["field"] = json!(field);
        }
        value.data = Some(data);
        value
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({"defined":self.status.is_client_error(),"code":self.code,"status":self.status.as_u16(),"message":self.message});
        if let Some(data) = self.data {
            body["data"] = data;
        }
        (self.status, Json(body)).into_response()
    }
}
impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match &error {
            StoreError::Unauthenticated => Self::new(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "A valid Forge API key is required.",
            ),
            StoreError::Forbidden
            | StoreError::NoActiveWorkspace
            | StoreError::EmailNotVerified => Self::new(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "The credential cannot perform this operation.",
            ),
            StoreError::RateLimited => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                error.to_string(),
            ),
            StoreError::InvalidInput => Self::invalid(),
            StoreError::NotFound
            | StoreError::Team(TeamError::NotFound | TeamError::ConfirmationMismatch) => Self::new(
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                "The requested resource was not found.",
            ),
            StoreError::Team(team) => match team {
                TeamError::SlugTaken | TeamError::IdentifierTaken | TeamError::TeamLimit => {
                    let reason = team.code();
                    let field = team.field();
                    Self::conflict(error, reason, field)
                }
                TeamError::InvalidInput | TeamError::EmptySlug => {
                    Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", error.to_string())
                }
                _ => Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_SERVER_ERROR",
                    "The operation could not be completed.",
                ),
            },
            StoreError::CommandReused => Self::conflict(error, "IDEMPOTENCY_KEY_REUSED", None),
            StoreError::CommandAmbiguous => {
                Self::conflict(error, "IDEMPOTENCY_RECONCILIATION_REQUIRED", None)
            }
            StoreError::CommandResultUnavailable => {
                Self::conflict(error, "IDEMPOTENCY_RESULT_UNAVAILABLE", None)
            }
            _ => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_SERVER_ERROR",
                "The operation could not be completed.",
            ),
        }
    }
}
pub(crate) async fn guard(
    State(state): State<AppState>,
    mut request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let enabled =
        state
            .public_api
            .unwrap_or_else(|| match std::env::var("PUBLIC_API_ENABLED").as_deref() {
                Ok("true") => true,
                Ok("false") => false,
                _ => std::env::var("NODE_ENV").as_deref() != Ok("production"),
            });
    if !enabled {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let request_id = Uuid::new_v4().to_string();
    request
        .extensions_mut()
        .insert(RequestId(request_id.clone()));
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        "x-request-id",
        header::HeaderValue::from_str(&request_id).expect("UUID header"),
    );
    response
}
async fn actor(state: &AppState, headers: &HeaderMap) -> Result<Actor, ApiError> {
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(forge_identity::bearer_credential)
        .filter(|v| v.len() >= 64)
        .ok_or_else(|| ApiError::from(StoreError::Unauthenticated))?;
    let (database, _) = configuration(state).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "The API is not configured.",
        )
    })?;
    Ok(authority::api_key_actor(database, credential).await?)
}
fn database(state: &AppState) -> Result<&forge_store::Database, ApiError> {
    state.pool.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "The API is not configured.",
        )
    })
}
pub(crate) async fn spec() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json")],
        include_str!("../templates/openapi.json"),
    )
}
pub(crate) async fn docs() -> Html<&'static str> {
    Html(include_str!("../templates/api-reference.html"))
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
    input: Result<Query<Page>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&state, &headers).await?;
    let Query(input) = input.map_err(|_| ApiError::invalid())?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid());
    }
    Ok(Json(
        teams::list(database(&state)?, &actor, input.cursor.as_deref(), limit).await?,
    ))
}
pub(crate) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&state, &headers).await?;
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::invalid())?;
    Ok(Json(json!(
        teams::get(database(&state)?, &actor, &Selector::Id(id))
            .await?
            .ok_or(StoreError::NotFound)?
    )))
}
pub(crate) async fn create(
    State(state): State<AppState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    headers: HeaderMap,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let actor = actor(&state, &headers).await?;
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .map(forge_core::text::trim)
        .filter(|k| !k.is_empty() && k.len() <= 255 && k.bytes().all(|b| (32..=126).contains(&b)))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "BAD_REQUEST",
                "Provide an Idempotency-Key header of at most 255 characters.",
            )
        })?;
    let Json(raw) = payload.map_err(|_| ApiError::invalid())?;
    let input = CreateTeam::parse(raw).map_err(|_| ApiError::invalid())?;
    let result = teams::create_idempotent(database(&state)?, &actor, &input, key).await;
    audit(
        &request_id,
        "teams.create",
        match &result {
            Ok(v) if v.replayed => "replayed",
            Ok(_) => "succeeded",
            Err(_) => "rejected",
        },
    );
    Ok((StatusCode::CREATED, Json(json!(result?.value))))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Update {
    settings: Value,
}
pub(crate) async fn update(
    State(state): State<AppState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    headers: HeaderMap,
    Path(id): Path<String>,
    payload: Result<Json<Update>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&state, &headers).await?;
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::invalid())?;
    let Json(raw) = payload.map_err(|_| ApiError::invalid())?;
    let input = TeamSettings::parse(raw.settings).map_err(|_| ApiError::invalid())?;
    let result = teams::update(database(&state)?, &actor, &Selector::Id(id), &input).await;
    audit(
        &request_id,
        "teams.update",
        if result.is_ok() {
            "succeeded"
        } else {
            "rejected"
        },
    );
    Ok(Json(json!(result?)))
}
pub(crate) async fn archive(
    State(state): State<AppState>,
    axum::Extension(request_id): axum::Extension<RequestId>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&state, &headers).await?;
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::invalid())?;
    let result = teams::archive(database(&state)?, &actor, &Selector::Id(id), None).await;
    audit(
        &request_id,
        "teams.archive",
        if result.is_ok() {
            "succeeded"
        } else {
            "rejected"
        },
    );
    Ok(Json(result?))
}
fn audit(request_id: &RequestId, operation: &str, outcome: &str) {
    eprintln!(
        "{}",
        json!({"schemaVersion":1,"event":"forge.api.mutation","operation":operation,"outcome":outcome,"requestId":request_id.0})
    );
}
