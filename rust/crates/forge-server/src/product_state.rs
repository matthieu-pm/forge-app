use crate::{
    auth::{configuration, cookie_token},
    issues::{IssueHttpError, Payload, context},
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_core::actor::Authentication;
use forge_store::{authority, initiatives::InitiativeOptions, product_state};
use serde_json::{Value, json};
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, auth) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        product_state::read(db, &actor, InitiativeOptions::from_env()).await?,
    ))
}
pub(crate) async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, mut input) = context(&state, &headers, payload).await?;
    input["workspaceId"] = json!(a.workspace_id);
    input["sessionId"] = json!(match &a.authentication {
        Authentication::Session { session_id } => session_id.as_str(),
        _ => unreachable!("session context"),
    });
    Ok(Json(
        product_state::save(db, &a, input, InitiativeOptions::from_env()).await?,
    ))
}
