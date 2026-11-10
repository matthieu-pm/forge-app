use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn live_is_available_without_product_dependencies() {
    let response = forge_server::router()
        .oneshot(
            Request::get("/api/health/live")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"status": "ok", "code": "ALIVE"})
    );
}

#[tokio::test]
async fn readiness_does_not_claim_unmigrated_features_work() {
    let response = forge_server::router()
        .oneshot(
            Request::get("/api/health/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn unmigrated_routes_are_not_successful_placeholders() {
    let response = forge_server::router()
        .oneshot(Request::get("/api/v1/issues").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
