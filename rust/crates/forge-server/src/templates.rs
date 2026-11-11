use crate::{
    documents::{Payload, document_context as context},
    issues::IssueHttpError,
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_core::features::{FeatureMode, FeatureRollouts, ProductFeature};
use forge_store::{StoreError, templates};
use serde_json::Value;

async fn dispatch(
    state: AppState,
    headers: HeaderMap,
    payload: Payload,
    recurring: bool,
    action: &str,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, actor, input) = context(&state, &headers, payload).await?;
    if recurring {
        let raw = std::env::var("FORGE_FEATURE_ROLLOUTS").ok();
        let rollouts = FeatureRollouts::parse(raw.as_deref()).unwrap_or_default();
        if rollouts.mode(ProductFeature::RecurringIssues, &actor.workspace_id, false)
            != FeatureMode::Enabled
        {
            return Err(StoreError::Forbidden.into());
        }
    }
    Ok(Json(match action {
        "read" => templates::read(db, &actor, input, recurring).await?,
        "save" => templates::save(db, &actor, input, recurring).await?,
        "delete" => templates::delete(db, &actor, input, recurring).await?,
        "default" => templates::set_default(db, &actor, input).await?,
        _ => return Err(StoreError::InvalidInput.into()),
    }))
}
pub(crate) async fn read(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, false, "read").await
}
pub(crate) async fn save(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, false, "save").await
}
pub(crate) async fn delete(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, false, "delete").await
}
pub(crate) async fn set_default(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, false, "default").await
}
pub(crate) async fn recurring_read(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, true, "read").await
}
pub(crate) async fn recurring_save(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, true, "save").await
}
pub(crate) async fn recurring_delete(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, true, "delete").await
}
