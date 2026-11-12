use crate::{
    documents::{Payload, document_context},
    issues::IssueHttpError,
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_store::{
    StoreError,
    calls::{Options, Service},
};
use serde_json::{Value, json};

async fn dispatch(
    state: AppState,
    headers: HeaderMap,
    payload: Payload,
    action: &str,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, actor, input) = document_context(&state, &headers, payload).await?;
    let service = Service::new(db.clone(), Options::from_env());
    let value = match action {
        "list" => service.list(&actor, input).await?,
        "read" => service.read(&actor, input).await?,
        "import" => json!(service.import(&actor, input).await?),
        "note" => {
            service.add_note(&actor, input).await?;
            Value::Null
        }
        "action" => {
            service.set_action(&actor, input).await?;
            Value::Null
        }
        "retention" => {
            service.save_retention(&actor, input).await?;
            Value::Null
        }
        "disconnect" => {
            service.disconnect(&actor, input).await?;
            Value::Null
        }
        _ => return Err(StoreError::InvalidInput.into()),
    };
    Ok(Json(value))
}
pub(crate) async fn list(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "list").await
}
pub(crate) async fn read(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "read").await
}
pub(crate) async fn import(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "import").await
}
pub(crate) async fn note(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "note").await
}
pub(crate) async fn action(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "action").await
}
pub(crate) async fn retention(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "retention").await
}
pub(crate) async fn disconnect(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "disconnect").await
}
