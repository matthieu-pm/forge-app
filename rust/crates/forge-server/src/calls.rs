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
    let service = service(&state, db);
    let value = match action {
        "list" => service.list(&actor, input).await?,
        "read" => service.read(&actor, input).await?,
        "import" => json!(service.import(&actor, input).await?),
        "connect" => json!(service.begin_connection(&actor, input).await?),
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
fn service(state: &AppState, database: &forge_store::Database) -> Service {
    state.calls.as_ref().map_or_else(
        || Service::new(database.clone(), Options::from_env()),
        |s| s.service(database.clone()),
    )
}
pub(crate) async fn connect(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    dispatch(s, h, p, "connect").await
}
pub(crate) async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
) -> axum::response::Response {
    use axum::{
        http::{StatusCode, header},
        response::IntoResponse,
    };
    let query: Vec<_> =
        url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()).collect();
    let get = |key: &str| {
        query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
            .unwrap_or("")
    };
    let result: Result<(), IssueHttpError> = async {
        let oauth_state = get("state");
        let code = get("code");
        if oauth_state.is_empty()
            || code.is_empty()
            || oauth_state.encode_utf16().count() > 256
            || code.encode_utf16().count() > 4096
        {
            return Err(StoreError::InvalidInput.into());
        }
        let (database, auth) = crate::auth::configuration(&state)?;
        let token = crate::auth::cookie_token(&headers, auth)?;
        let actor = forge_store::authority::session_actor(database, &token).await?;
        service(&state, database)
            .finish_connection(&actor, oauth_state, code)
            .await?;
        Ok(())
    }
    .await;
    (
        StatusCode::SEE_OTHER,
        [
            (
                header::LOCATION,
                if result.is_ok() {
                    "/workspace/calls?connection=connected"
                } else {
                    "/workspace/calls?connection=error"
                },
            ),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
    )
        .into_response()
}
