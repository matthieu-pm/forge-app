use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use forge_server::{retention::Settings, sla, state::AppState};
use forge_store::jobs::{Code, Error};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn sla_scheduler_denies_before_work_and_reports_deferred_as_healthy() {
    let secret = "x".repeat(48);
    for enabled in [false, true] {
        for length in [8, 48] {
            for method in [Method::GET, Method::POST, Method::HEAD] {
                for auth in ["", "Bearer wrong", &format!("Bearer {secret}")] {
                    let settings = Settings {
                        enabled,
                        secret: secret[..length].into(),
                    };
                    let valid = enabled
                        && length == 48
                        && method == Method::GET
                        && auth == format!("Bearer {secret}");
                    let request = Request::builder()
                        .method(method.clone())
                        .header("authorization", auth)
                        .body(Body::empty())
                        .unwrap();
                    let response=sla::handle_scheduler(request,Some(&settings),||async{assert!(valid,"denied request reached worker");Ok(json!({"dispatched":2,"results":[{"state":"completed"},{"state":"deferred"}]}))}).await;
                    assert_eq!(
                        response.status(),
                        if valid {
                            StatusCode::OK
                        } else {
                            StatusCode::NOT_FOUND
                        }
                    );
                    assert_eq!(response.headers()["cache-control"], "no-store");
                    if valid {
                        let body: Value = serde_json::from_slice(
                            &to_bytes(response.into_body(), 1000).await.unwrap(),
                        )
                        .unwrap();
                        assert_eq!(body, json!({"dispatched":2,"processed":2,"failed":false}));
                    }
                }
            }
        }
    }
    let settings = Settings {
        enabled: true,
        secret: secret.clone(),
    };
    for state in ["retry", "dead", "reconcile", "lost"] {
        let request = Request::builder()
            .header("authorization", format!("Bearer {secret}"))
            .body(Body::empty())
            .unwrap();
        let response = sla::handle_scheduler(request, Some(&settings), || async {
            Ok(json!({"dispatched":0,"results":[{"state":state}]}))
        })
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    let request = Request::builder()
        .header("authorization", format!("Bearer {secret}"))
        .body(Body::empty())
        .unwrap();
    let response = sla::handle_scheduler(request, Some(&settings), || async {
        Err(Error::from(Code::JobFailed))
    })
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 1000).await.unwrap())
            .unwrap(),
        json!({"code":"SLA_JOB_FAILED"})
    );
}
#[tokio::test]
async fn sla_scheduler_route_rejects_duplicate_credentials_and_redacts_unavailable_database() {
    let secret = "x".repeat(48);
    for duplicate in [false, true] {
        let mut request = Request::builder()
            .uri("/api/internal/sla-jobs")
            .header("authorization", format!("Bearer {secret}"));
        if duplicate {
            request = request.header("authorization", format!("Bearer {secret}"));
        }
        let response = forge_server::router_with_state(
            AppState::default().with_sla_scheduler(true, secret.clone()),
        )
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
        assert_eq!(
            response.status(),
            if duplicate {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            }
        );
        if !duplicate {
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &to_bytes(response.into_body(), 1000).await.unwrap()
                )
                .unwrap(),
                json!({"code":"SLA_JOB_FAILED"})
            );
        }
    }
}
