use crate::{
    issues::{IssueHttpError, Payload, context},
    retention,
    state::AppState,
};
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use forge_core::actor::{Actor, Authentication};
use forge_store::{
    jobs::{Code, Error, JobStore},
    sla,
};
use serde_json::{Value, json};
fn identity(input: &mut Value, a: &Actor) {
    input["workspaceId"] = json!(a.workspace_id);
    if let Authentication::Session { session_id } = &a.authentication {
        input["sessionId"] = json!(session_id);
    }
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, mut input) = context(&state, &headers, payload).await?;
    identity(&mut input, &a);
    Ok(Json(sla::read(db, &a, input).await?))
}
pub(crate) async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, mut input) = context(&state, &headers, payload).await?;
    identity(&mut input, &a);
    Ok(Json(sla::save(db, &a, input).await?))
}
pub(crate) async fn reconcile(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let (db, a, mut input) = context(&state, &headers, payload).await?;
    identity(&mut input, &a);
    Ok(Json(sla::reconcile(db, &a, input).await?))
}
pub async fn handle_scheduler<F, Fut>(
    request: Request,
    settings: Option<&retention::Settings>,
    run: F,
) -> Response
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, Error>>,
{
    if !retention::authorized(&request, settings) {
        return (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-store")]).into_response();
    }
    match run().await {
        Ok(result) => {
            let Some(results) = result["results"].as_array() else {
                return failure();
            };
            let failed = results
                .iter()
                .any(|r| !matches!(r["state"].as_str(), Some("completed" | "idle" | "deferred")));
            (if failed{StatusCode::SERVICE_UNAVAILABLE}else{StatusCode::OK},[(header::CACHE_CONTROL,"no-store")],Json(json!({"dispatched":result["dispatched"],"processed":results.len(),"failed":failed}))).into_response()
        }
        Err(_) => failure(),
    }
}
fn failure() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"code":"SLA_JOB_FAILED"})),
    )
        .into_response()
}
pub(crate) async fn scheduler(State(state): State<AppState>, request: Request) -> Response {
    handle_scheduler(request, state.sla_scheduler.as_deref(), || async {
        let db = state.pool.as_ref().ok_or(Error::from(Code::JobFailed))?;
        sla::run_jobs(db, &JobStore::new(db.clone())).await
    })
    .await
}
