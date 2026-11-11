use crate::{
    auth::{self, configuration, cookie_token},
    files::storage::Inspector,
    issues::{IssueHttpError, Payload},
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_store::{authority, profiles};
use serde_json::{Value, json};
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, settings) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, settings)?).await?;
    if !state.profile_editing {
        return Ok(Json(json!({"status":"disabled"})));
    }
    Ok(Json(
        json!({"status":"ready","snapshot":profiles::read(db,&actor,true).await?}),
    ))
}
pub(crate) async fn patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, settings) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, settings)?).await?;
    Ok(Json(
        profiles::patch(db, &actor, input, state.profile_editing, &Inspector).await?,
    ))
}
