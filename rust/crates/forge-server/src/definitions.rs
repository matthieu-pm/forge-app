use crate::{
    auth::{self, AuthError, configuration, cookie_token},
    state::AppState,
};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use forge_store::{
    StoreError, authority,
    definitions::{self, Classification, DefinitionCommand},
};
use serde_json::{Value, json};

pub(crate) enum DefinitionHttpError {
    Auth(AuthError),
    Conflict(&'static str),
}
impl From<AuthError> for DefinitionHttpError {
    fn from(error: AuthError) -> Self {
        Self::Auth(error)
    }
}
impl From<StoreError> for DefinitionHttpError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::DefinitionConflict(message) => Self::Conflict(message),
            error => Self::Auth(error.into()),
        }
    }
}
impl IntoResponse for DefinitionHttpError {
    fn into_response(self) -> Response {
        match self {
            Self::Auth(error) => error.into_response(),
            Self::Conflict(message) => (
                StatusCode::CONFLICT,
                Json(json!({"code":"DEFINITION_CONFLICT","message":message})),
            )
                .into_response(),
        }
    }
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, DefinitionHttpError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(definitions::read_all(database, &actor).await?))
}
pub(crate) async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<DefinitionCommand>, JsonRejection>,
) -> Result<Json<Value>, DefinitionHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(json!(
        definitions::save(database, &actor, &input).await?
    )))
}
pub(crate) async fn classify(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<Classification>, JsonRejection>,
) -> Result<Json<Value>, DefinitionHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(definitions::classify(database, &actor, &input).await?))
}
