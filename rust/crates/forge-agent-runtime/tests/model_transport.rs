use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Response, StatusCode},
    routing::post,
};
use forge_agent_runtime::{
    Error, Result,
    auth::Channel,
    callback::PeerIdentity,
    model::{
        stream::{Completion, Delta},
        transport::{HttpModel, Model, Sink, Turn},
    },
    sandbox::Cancellation,
};
use forge_core::agents::tokens::{Kind, mint};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};
use url::Url;
const RUN: &str = "00000000-0000-4000-8000-000000000001";
fn channel(provider: &str) -> Channel {
    let secret = "public-model-transport-fixture-secret";
    let token=mint(secret,Kind::RuntimeChannel,json!({"sub":"fixture-user","workspaceId":"fixture-workspace","runId":RUN,"correlationId":RUN,"forgeCapabilityToken":"public-capability-token","forgeModelAccessToken":"public-model-access-token","provider":provider,"modelId":"bound-model","reasoningEffort":"medium"}),1000,900.).unwrap();
    Channel::verify(secret, &format!("Bearer {token}"), 1001).unwrap()
}
fn fixture(protocol: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("../../../reference-fixtures.json")).unwrap()["modelStreams"].as_array().unwrap().iter().find(|v|v["protocol"]==protocol&&v["mode"]=="mixed").unwrap()["events"].as_array().unwrap().clone()
}
fn wire(protocol: &str) -> Vec<u8> {
    fixture(protocol)
        .iter()
        .map(|v| {
            format!(
                "data: {}\r\n\r\n",
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| serde_json::to_string(v).unwrap())
            )
        })
        .collect::<String>()
        .into_bytes()
}
struct Provider {
    wire: Vec<u8>,
    status: StatusCode,
    mime: &'static str,
    stall: bool,
    requests: Mutex<Vec<Value>>,
}
async fn handle(State(state): State<Arc<Provider>>, request: Request) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 4 * 1024 * 1024).await.unwrap();
    state.requests.lock().unwrap().push(json!({"path":parts.uri.to_string(),"authorization":parts.headers.get("authorization").unwrap().to_str().unwrap(),"correlation":parts.headers.get("x-correlation-id").unwrap().to_str().unwrap(),"run":parts.headers.get("x-forge-agent-run-id").unwrap().to_str().unwrap(),"workspace":parts.headers.get("x-forge-workspace-id").unwrap().to_str().unwrap(),"peer":parts.headers.get("x-vercel-trusted-oidc-idp-token").map(|v|v.to_str().unwrap()),"body":serde_json::from_slice::<Value>(&bytes).unwrap()}));
    let chunks: Vec<_> = state
        .wire
        .chunks(7)
        .map(|v| Ok::<_, std::io::Error>(v.to_vec()))
        .collect();
    let source = stream::iter(chunks).chain(stream::unfold(state.stall, |stall| async move {
        if stall {
            std::future::pending::<()>().await;
        }
        None::<(std::result::Result<Vec<u8>, std::io::Error>, bool)>
    }));
    Response::builder()
        .status(state.status)
        .header("content-type", state.mime)
        .header("location", "http://127.0.0.1:9/private")
        .body(Body::from_stream(source))
        .unwrap()
}
struct Server {
    state: Arc<Provider>,
    origin: Url,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn new(wire: Vec<u8>, status: StatusCode, mime: &'static str, stall: bool) -> Self {
        let state = Arc::new(Provider {
            wire,
            status,
            mime,
            stall,
            requests: Mutex::new(vec![]),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/api/agent/runtime/model/{*path}", post(handle))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            state,
            origin: Url::parse(&format!("http://{address}/ignored?discard=true#fragment")).unwrap(),
            task,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Default)]
struct Recording {
    events: Vec<Delta>,
    entered: Option<Arc<Notify>>,
    pending: bool,
    fail: bool,
}
#[async_trait]
impl Sink for Recording {
    async fn emit(&mut self, delta: Delta) -> Result<()> {
        self.events.push(delta);
        if let Some(entered) = &self.entered {
            entered.notify_one();
        }
        if self.pending {
            std::future::pending::<()>().await;
        }
        if self.fail {
            return Err(Error("Event persistence failed."));
        }
        Ok(())
    }
}
struct Identity {
    calls: AtomicUsize,
    pending: bool,
    entered: Notify,
    dropped: Arc<AtomicUsize>,
}
impl Default for Identity {
    fn default() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            pending: false,
            entered: Notify::new(),
            dropped: Arc::new(AtomicUsize::new(0)),
        }
    }
}
struct Guard(Arc<AtomicUsize>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl PeerIdentity for Identity {
    async fn token(&self) -> Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        let _guard = Guard(self.dropped.clone());
        if self.pending {
            std::future::pending::<()>().await;
        }
        Ok("public-reviewed-peer-token".into())
    }
}
async fn generate(
    model: &HttpModel,
    provider: &str,
    cancel: &Cancellation,
    sink: &mut dyn Sink,
    deadline: Instant,
) -> Result<Completion> {
    let prompt = [json!({"role":"user","content":[{"type":"text","text":"Hello"}]})];
    model
        .generate(
            &channel(provider),
            Turn {
                prompt: &prompt,
                tools: &[],
                max_output_tokens: Some(1024),
                deadline,
            },
            cancel,
            sink,
        )
        .await
}
#[tokio::test]
async fn all_protocols_use_the_bound_proxy_credentials_and_preserve_fragmented_unicode() {
    for (protocol, provider, path) in [
        ("responses", "openai", "responses"),
        ("chat", "custom-openai", "chat/completions"),
        ("anthropic", "anthropic", "messages"),
    ] {
        let server = Server::new(
            wire(protocol),
            StatusCode::OK,
            "text/event-stream; charset=utf-8",
            false,
        )
        .await;
        let identity = Arc::new(Identity::default());
        let model = HttpModel::new(
            server.origin.clone(),
            Some((server.origin.clone(), identity.clone())),
        )
        .unwrap();
        let mut sink = Recording::default();
        let result = generate(
            &model,
            provider,
            &Cancellation::default(),
            &mut sink,
            Instant::now() + Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(
            result.content.iter().find(|v| v["type"] == "text").unwrap()["text"],
            "Hello hé😀"
        );
        assert_eq!(
            result
                .content
                .iter()
                .filter(|v| v["type"] == "tool-call")
                .count(),
            1
        );
        assert_eq!(identity.calls.load(Ordering::SeqCst), 1);
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request["path"], format!("/api/agent/runtime/model/{path}"));
        assert_eq!(request["authorization"], "Bearer public-model-access-token");
        assert_eq!(request["peer"], "public-reviewed-peer-token");
        assert_eq!(request["run"], RUN);
        assert_eq!(request["correlation"], RUN);
        assert_eq!(request["workspace"], "fixture-workspace");
        assert_eq!(request["body"]["model"], "bound-model");
        assert!(
            !serde_json::to_string(request)
                .unwrap()
                .contains("capability-token")
        );
    }
}
#[tokio::test]
async fn redirects_error_bodies_wrong_mime_and_truncated_frames_never_complete() {
    for (body, status, mime) in [
        (
            b"sk-private-provider-error".to_vec(),
            StatusCode::BAD_GATEWAY,
            "text/event-stream",
        ),
        (
            wire("chat"),
            StatusCode::TEMPORARY_REDIRECT,
            "text/event-stream",
        ),
        (wire("chat"), StatusCode::OK, "application/json"),
        (
            b"data: {\"choices\":[]}".to_vec(),
            StatusCode::OK,
            "text/event-stream",
        ),
        (
            b"data: \xff\n\n".to_vec(),
            StatusCode::OK,
            "text/event-stream",
        ),
    ] {
        let server = Server::new(body, status, mime, false).await;
        let model = HttpModel::new(server.origin.clone(), None).unwrap();
        let error = generate(
            &model,
            "custom-openai",
            &Cancellation::default(),
            &mut Recording::default(),
            Instant::now() + Duration::from_secs(5),
        )
        .await
        .err()
        .unwrap();
        assert!(!error.to_string().contains("sk-private"));
        assert_eq!(server.state.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn deadline_and_cancellation_cover_stalled_network_and_sink_backpressure() {
    for pending_sink in [false, true] {
        let server = Server::new(wire("chat"), StatusCode::OK, "text/event-stream", true).await;
        let entered = Arc::new(Notify::new());
        let cancel = Cancellation::default();
        let task_cancel = cancel.clone();
        let task_entered = entered.clone();
        let model = HttpModel::new(server.origin.clone(), None).unwrap();
        let task = tokio::spawn(async move {
            let mut sink = Recording {
                entered: Some(task_entered),
                pending: pending_sink,
                ..Recording::default()
            };
            generate(
                &model,
                "custom-openai",
                &task_cancel,
                &mut sink,
                Instant::now() + Duration::from_secs(10),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert!(error.to_string().contains("cancelled"));
        let model = HttpModel::new(server.origin.clone(), None).unwrap();
        let mut sink = Recording {
            pending: pending_sink,
            ..Recording::default()
        };
        let error = generate(
            &model,
            "custom-openai",
            &Cancellation::default(),
            &mut sink,
            Instant::now() + Duration::from_millis(100),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("timed out"));
    }
}
#[tokio::test]
async fn revoked_or_expired_work_and_unreviewed_origins_do_not_acquire_credentials() {
    let identity = Arc::new(Identity::default());
    let origin = Url::parse("http://127.0.0.1:9").unwrap();
    assert!(
        HttpModel::new(
            origin.clone(),
            Some((
                Url::parse("https://different.test").unwrap(),
                identity.clone()
            ))
        )
        .is_err()
    );
    assert!(
        HttpModel::new(
            Url::parse("https://user:password@forge.test").unwrap(),
            None
        )
        .is_err()
    );
    let model = HttpModel::new(origin.clone(), Some((origin, identity.clone()))).unwrap();
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(
        generate(
            &model,
            "openai",
            &cancel,
            &mut Recording::default(),
            Instant::now() + Duration::from_secs(10)
        )
        .await
        .is_err()
    );
    assert!(
        generate(
            &model,
            "openai",
            &Cancellation::default(),
            &mut Recording::default(),
            Instant::now()
        )
        .await
        .is_err()
    );
    assert_eq!(identity.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn credential_acquisition_is_cancelled_and_sink_failures_stop_generation() {
    let identity = Arc::new(Identity {
        pending: true,
        ..Identity::default()
    });
    let origin = Url::parse("http://127.0.0.1:9").unwrap();
    let model = HttpModel::new(origin.clone(), Some((origin, identity.clone()))).unwrap();
    let cancel = Cancellation::default();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        generate(
            &model,
            "openai",
            &task_cancel,
            &mut Recording::default(),
            Instant::now() + Duration::from_secs(10),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), identity.entered.notified())
        .await
        .unwrap();
    cancel.cancel();
    assert!(task.await.unwrap().is_err());
    assert_eq!(identity.dropped.load(Ordering::SeqCst), 1);
    let server = Server::new(wire("chat"), StatusCode::OK, "text/event-stream", false).await;
    let model = HttpModel::new(server.origin.clone(), None).unwrap();
    let mut sink = Recording {
        fail: true,
        ..Recording::default()
    };
    assert!(
        generate(
            &model,
            "custom-openai",
            &Cancellation::default(),
            &mut sink,
            Instant::now() + Duration::from_secs(5)
        )
        .await
        .is_err()
    );
    assert_eq!(sink.events.len(), 1);
}
