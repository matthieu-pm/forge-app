use crate::state::AppState;
use axum::{
    Json,
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use forge_store::issues::purge::{self, Report};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub struct Settings {
    pub enabled: bool,
    pub secret: String,
}
pub async fn handle<F, Fut>(request: Request, settings: Option<&Settings>, run: F) -> Response
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Report, forge_store::StoreError>>,
{
    let allowed = settings.is_some_and(|s| {
        s.enabled
            && s.secret.encode_utf16().count() >= 32
            && request.method() == Method::GET
            && request
                .headers()
                .get_all(header::AUTHORIZATION)
                .iter()
                .count()
                == 1
            && bool::from(
                Sha256::digest(
                    request
                        .headers()
                        .get(header::AUTHORIZATION)
                        .map(|h| h.as_bytes())
                        .unwrap_or_default(),
                )
                .ct_eq(&Sha256::digest(format!("Bearer {}", s.secret).as_bytes())),
            )
    });
    if !allowed {
        return (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-store")]).into_response();
    }
    match run().await {
        Ok(report) => (
            if report.failed > 0 {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::OK
            },
            [(header::CACHE_CONTROL, "no-store")],
            Json(report),
        )
            .into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"code":"ISSUE_RETENTION_FAILED"})),
        )
            .into_response(),
    }
}
pub(crate) async fn route(State(state): State<AppState>, request: Request) -> Response {
    handle(request, state.issue_retention.as_deref(), || async {
        let db = state
            .pool
            .as_ref()
            .ok_or(forge_store::StoreError::InvalidInput)?;
        let files = state
            .files
            .as_ref()
            .ok_or(forge_store::StoreError::InvalidInput)?;
        purge::run(db, &files.storage).await
    })
    .await
}
