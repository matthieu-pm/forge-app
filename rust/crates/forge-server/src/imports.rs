use crate::{
    auth::{self, configuration, cookie_token},
    issues::{IssueHttpError, Payload},
    state::AppState,
};
use axum::{Json, extract::State, http::HeaderMap};
use forge_store::{
    authority,
    imports::{self, ImportOptions},
};
use serde_json::Value;
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, config) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, config)?).await?;
    Ok(Json(
        imports::read(db, &actor, input, ImportOptions::from_env()).await?,
    ))
}
pub(crate) async fn prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Payload,
) -> Result<Json<Value>, IssueHttpError> {
    let Json(input) = payload.map_err(|_| auth::invalid_body())?;
    let (db, config) = configuration(&state)?;
    let actor = authority::session_actor(db, &cookie_token(&headers, config)?).await?;
    Ok(Json(
        imports::prepare(db, &actor, input, ImportOptions::from_env()).await?,
    ))
}

macro_rules! endpoint {
    ($name:ident,$service:ident) => {
        pub(crate) async fn $name(
            State(state): State<AppState>,
            headers: HeaderMap,
            payload: Payload,
        ) -> Result<Json<Value>, IssueHttpError> {
            let Json(input) = payload.map_err(|_| auth::invalid_body())?;
            let (db, config) = configuration(&state)?;
            let actor = authority::session_actor(db, &cookie_token(&headers, config)?).await?;
            Ok(Json(
                imports::$service(db, &actor, input, ImportOptions::from_env()).await?,
            ))
        }
    };
}
endpoint!(read_one, read_one);
endpoint!(batch, batch);
endpoint!(choose, choose);
endpoint!(file, finalize_file);
endpoint!(retry, retry);
endpoint!(pause, pause);
endpoint!(cutover, cutover);
endpoint!(report, download_report);
