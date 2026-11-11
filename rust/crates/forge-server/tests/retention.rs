use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use forge_server::{
    retention::{self, Settings},
    state::AppState,
};
use forge_store::issues::purge::Report;
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn issue_retention_authentication_is_closed_before_worker_loading() {
    let secret = "x".repeat(48);
    for enabled in [false, true] {
        for length in [8, 48] {
            for method in [Method::GET, Method::POST, Method::HEAD] {
                for auth in ["", "Bearer wrong", &format!("Bearer {secret}")] {
                    let settings = Settings {
                        enabled,
                        secret: secret[..length].into(),
                    };
                    let request = Request::builder()
                        .method(method.clone())
                        .header("authorization", auth)
                        .body(Body::empty())
                        .unwrap();
                    let valid = enabled
                        && length == 48
                        && method == Method::GET
                        && auth == format!("Bearer {secret}");
                    let response = retention::handle(request, Some(&settings), || async {
                        assert!(valid, "denied request reached worker");
                        Ok(Report {
                            purged: 1,
                            failed: 0,
                            pending: true,
                        })
                    })
                    .await;
                    assert_eq!(
                        response.status(),
                        if valid {
                            StatusCode::OK
                        } else {
                            StatusCode::NOT_FOUND
                        }
                    );
                    assert_eq!(response.headers()["cache-control"], "no-store");
                }
            }
        }
    }
    let request = Request::builder()
        .uri("/api/internal/issue-retention")
        .header("authorization", format!("Bearer {secret}"))
        .header("authorization", format!("Bearer {secret}"))
        .body(Body::empty())
        .unwrap();
    let response = forge_server::router_with_state(
        AppState::default().with_issue_retention(true, secret.clone()),
    )
    .oneshot(request)
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let request = Request::builder()
        .uri("/api/internal/issue-retention")
        .header("authorization", format!("Bearer {secret}"))
        .body(Body::empty())
        .unwrap();
    let response =
        forge_server::router_with_state(AppState::default().with_issue_retention(true, secret))
            .oneshot(request)
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 1000).await.unwrap())
            .unwrap(),
        json!({"code":"ISSUE_RETENTION_FAILED"})
    );
}
#[tokio::test]
async fn issue_retention_reports_pending_and_failure_without_provider_details() {
    let settings = Settings {
        enabled: true,
        secret: "x".repeat(48),
    };
    for failed in [0, 1, 2] {
        let request = Request::builder()
            .header("authorization", format!("Bearer {}", settings.secret))
            .body(Body::empty())
            .unwrap();
        let response = retention::handle(request, Some(&settings), || async {
            if failed == 2 {
                Err(forge_store::StoreError::DefinitionConflict(
                    "private provider token",
                ))
            } else {
                Ok(Report {
                    purged: 1,
                    failed,
                    pending: true,
                })
            }
        })
        .await;
        assert_eq!(
            response.status(),
            if failed == 0 {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            }
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = to_bytes(response.into_body(), 1000).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("private"));
        if failed < 2 {
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({"purged":1,"failed":failed,"pending":true})
            );
        }
    }
}
