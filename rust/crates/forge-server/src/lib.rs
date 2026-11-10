//! Rust HTTP host. Routes are enabled only as their implementation is migrated.

use axum::{
    Json, Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

pub fn router() -> Router {
    Router::new()
        .route("/api/health/live", get(live))
        .route("/api/health/ready", get(ready))
}

fn health_response(code: &str, status: StatusCode) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(json!({"status": if status.is_success() { "ok" } else { "unhealthy" }, "code": code})),
    )
        .into_response()
}

async fn live() -> Response {
    health_response("ALIVE", StatusCode::OK)
}

async fn ready() -> Response {
    // A listening HTTP socket is not evidence that the product is ready.
    health_response("CONFIGURATION_INVALID", StatusCode::SERVICE_UNAVAILABLE)
}
