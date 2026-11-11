use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, Response, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::agents::{
    providers::{self, ModelClaims, RuntimeCredential},
    tokens::{self, Kind},
};
use forge_server::model_proxy::{self, Credentials, Settings, Upstream};
use forge_store::StoreError;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tower::ServiceExt;
const SECRET: &str = "public-proxy-fixture-secret-at-least-32";
const NOW: i64 = 1_793_534_400;
struct Loader {
    mode: String,
    loaded: AtomicUsize,
}
#[async_trait]
impl Credentials for Loader {
    async fn load(&self, claims: &ModelClaims) -> Result<Option<RuntimeCredential>, StoreError> {
        self.loaded.fetch_add(1, Ordering::SeqCst);
        match self.mode.as_str() {
            "missing" => Ok(None),
            "forbidden" => Err(StoreError::Forbidden),
            "failed" => Err(StoreError::InvalidInput),
            _ => Ok(Some(RuntimeCredential {
                api_key: "fixture-server-key".into(),
                provider: claims.provider.clone(),
                endpoint_url: Some("https://provider.test/v1/".into()),
            })),
        }
    }
}
struct Capture {
    spec: Value,
    sent: Mutex<Vec<Value>>,
}
#[async_trait]
impl Upstream for Capture {
    async fn send(
        &self,
        credential: RuntimeCredential,
        path: &str,
        accept: &str,
        body: Vec<u8>,
    ) -> Result<Response<Body>, StoreError> {
        let mut headers = serde_json::Map::new();
        headers.insert("accept".into(), json!(accept));
        headers.insert("content-type".into(), json!("application/json"));
        for (name, value) in providers::headers(&credential.provider, &credential.api_key) {
            headers.insert(name.into(), json!(value));
        }
        self.sent.lock().unwrap().push(json!({"url":format!("https://provider.test/v1/{path}"),"headers":headers,"bodyBase64":STANDARD.encode(&body),"redirect":"error"}));
        if self.spec["upstreamFailure"] == true {
            return Err(StoreError::InvalidInput);
        }
        Ok(Response::builder()
            .status(self.spec["status"].as_u64().unwrap_or(200) as u16)
            .header("content-type", "text/event-stream")
            .header("openai-version", "fixture")
            .header("retry-after", "1")
            .header("x-ratelimit-remaining-tokens", "9")
            .header("x-request-id", "upstream-private")
            .header("set-cookie", "provider-private")
            .header("x-api-key", "fixture-server-key")
            .body(Body::from("data: fixture\n\n"))
            .unwrap())
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap()
}
fn token(claims: Value) -> String {
    tokens::mint(SECRET, Kind::ModelAccess, claims, NOW, 900.).unwrap()
}
fn settings(loader: Arc<dyn Credentials>, upstream: Arc<dyn Upstream>) -> Settings {
    Settings {
        secret: SECRET.into(),
        enabled: true,
        connections_enabled: true,
        credentials: loader,
        upstream,
        now: Arc::new(|| NOW),
    }
}
#[tokio::test]
async fn model_proxy_matches_source_order_errors_binding_headers_and_streams() {
    let fixture = fixture();
    for case in fixture["modelProxy"]["cases"].as_array().unwrap() {
        let spec = &case["spec"];
        let loader = Arc::new(Loader {
            mode: spec["credential"].as_str().unwrap_or("").into(),
            loaded: AtomicUsize::new(0),
        });
        let upstream = Arc::new(Capture {
            spec: spec.clone(),
            sent: Mutex::new(Vec::new()),
        });
        let settings = settings(loader.clone(), upstream.clone());
        let mut claims = fixture["modelProxy"]["claims"].clone();
        claims["provider"] = json!(spec["provider"].as_str().unwrap_or("openai"));
        let authorization = if spec["invalidToken"] == true {
            "Bearer bad".into()
        } else {
            spec["authorization"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Bearer {}", token(claims)))
        };
        let method = spec["method"].as_str().unwrap_or("POST");
        let body = if method == "POST" {
            format!(
                "{}{}",
                spec["body"]
                    .as_str()
                    .unwrap_or("{\"model\":\"gpt-fixture\",\"input\":\"Fixture\",\"stream\":true}"),
                " ".repeat(spec["extraBytes"].as_u64().unwrap_or(0) as usize)
            )
        } else {
            String::new()
        };
        let mut request = Request::builder()
            .method(method)
            .header("authorization", authorization)
            .header(
                "accept",
                spec["accept"].as_str().unwrap_or("application/json"),
            )
            .header("x-api-key", "caller-private")
            .header("cookie", "caller-session");
        if let Some(length) = spec["length"].as_str() {
            request = request.header("content-length", length);
        }
        let response = model_proxy::handle(
            request.body(Body::from(body)).unwrap(),
            spec["path"].as_str().unwrap_or("responses"),
            &settings,
        )
        .await;
        assert_eq!(response.status().as_u16(), case["status"], "{spec}");
        assert!(
            uuid::Uuid::parse_str(response.headers()["x-request-id"].to_str().unwrap()).is_ok()
        );
        assert!(response.headers().get("set-cookie").is_none());
        assert!(response.headers().get("x-api-key").is_none());
        for (name, value) in case["headers"].as_object().unwrap() {
            assert_eq!(
                response.headers().get(name).unwrap().to_str().unwrap(),
                value.as_str().unwrap(),
                "{spec} {name}"
            );
        }
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            String::from_utf8_lossy(&bytes),
            case["body"].as_str().unwrap(),
            "{spec}"
        );
        assert_eq!(
            loader.loaded.load(Ordering::SeqCst),
            case["counters"]["loaded"].as_u64().unwrap() as usize,
            "{spec}"
        );
        let sent = upstream.sent.lock().unwrap();
        assert_eq!(
            sent.len(),
            case["counters"]["sent"].as_u64().unwrap() as usize,
            "{spec}"
        );
        if let Some(sent) = sent.first() {
            assert_eq!(*sent, case["sent"], "{spec}");
        }
    }
}
struct Stream {
    polled: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}
impl futures_util::Stream for Stream {
    type Item = Result<axum::body::Bytes, std::io::Error>;
    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.polled.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Ok(axum::body::Bytes::from_static(b"data: chunk\n\n"))))
    }
}
struct Streaming {
    polled: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
}
#[async_trait]
impl Upstream for Streaming {
    async fn send(
        &self,
        _: RuntimeCredential,
        _: &str,
        _: &str,
        _: Vec<u8>,
    ) -> Result<Response<Body>, StoreError> {
        Ok(Response::new(Body::from_stream(Stream {
            polled: self.polled.clone(),
            dropped: self.dropped.clone(),
        })))
    }
}
#[tokio::test]
async fn model_proxy_does_not_buffer_generation_and_dropping_response_stops_polling() {
    let polled = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let settings = settings(
        Arc::new(Loader {
            mode: String::new(),
            loaded: AtomicUsize::new(0),
        }),
        Arc::new(Streaming {
            polled: polled.clone(),
            dropped: dropped.clone(),
        }),
    );
    let request = Request::builder()
        .method("POST")
        .header(
            "authorization",
            format!(
                "Bearer {}",
                token(fixture()["modelProxy"]["claims"].clone())
            ),
        )
        .body(Body::from("{\"model\":\"gpt-fixture\"}"))
        .unwrap();
    let mut response = model_proxy::handle(request, "responses", &settings).await;
    assert_eq!(response.status(), 200);
    assert_eq!(polled.load(Ordering::SeqCst), 0);
    assert_eq!(
        response
            .body_mut()
            .frame()
            .await
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap(),
        "data: chunk\n\n"
    );
    assert_eq!(polled.load(Ordering::SeqCst), 1);
    drop(response);
    assert!(dropped.load(Ordering::SeqCst));
    assert_eq!(polled.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn runtime_routes_use_run_tokens_and_feature_gates_without_session_fallback() {
    for (enabled, connections) in [(true, true), (false, true), (true, false)] {
        let loader = Arc::new(Loader {
            mode: String::new(),
            loaded: AtomicUsize::new(0),
        });
        let upstream = Arc::new(Capture {
            spec: json!({}),
            sent: Mutex::new(Vec::new()),
        });
        let mut settings = settings(loader, upstream);
        settings.enabled = enabled;
        settings.connections_enabled = connections;
        let router = forge_server::router_with_state(
            forge_server::state::AppState::default().with_model_proxy(settings),
        );
        for namespace in ["model", "openai"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/agent/runtime/{namespace}/chat/completions"))
                        .method("POST")
                        .header(header::COOKIE, "better-auth.session_token=fixture")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if enabled && connections { 401 } else { 404 }
            );
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/agent/runtime/{namespace}/responses"))
                        .method("POST")
                        .header(
                            header::AUTHORIZATION,
                            format!(
                                "Bearer {}",
                                token(fixture()["modelProxy"]["claims"].clone())
                            ),
                        )
                        .body(Body::from("{\"model\":\"gpt-fixture\"}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if enabled && connections { 200 } else { 404 }
            );
        }
    }
}
