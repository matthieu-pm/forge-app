use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Request, Response, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::agents::{
    eve::Cursor,
    runtime::{Checkpoint, Context, Error, Identity, Runtime},
    tokens::{self, Kind},
};
use forge_server::agent_runtime::{EveRuntime, Options, PeerIdentity};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::Sha256;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use url::Url;

const SECRET: &str = "public-runtime-fixture-secret-at-least-32";
const NOW: i64 = 1_793_534_400;
const RUN: &str = "00000000-0000-4000-8000-000000000001";
#[derive(Default)]
struct Checkpoints {
    values: Mutex<Vec<Value>>,
    fail_at: usize,
}
#[async_trait]
impl Checkpoint for Checkpoints {
    async fn save(&self, encoded: String) -> Result<(), Error> {
        let value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        let mut values = self.values.lock().unwrap();
        values.push(value);
        if values.len() == self.fail_at {
            Err(Error("Fixture checkpoint failure."))
        } else {
            Ok(())
        }
    }
}
struct Capture {
    spec: Value,
    requests: Mutex<Vec<Value>>,
    headers: Mutex<Vec<HeaderMap>>,
}
async fn serve(State(capture): State<Arc<Capture>>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    capture.requests.lock().unwrap().push(json!({"path":parts.uri.to_string(),"method":parts.method.as_str(),"body":if bytes.is_empty(){Value::Null}else{serde_json::from_slice(&bytes).unwrap()},"correlation":parts.headers.get("x-correlation-id").map(|v|v.to_str().unwrap())}));
    capture.headers.lock().unwrap().push(parts.headers);
    let spec = &capture.spec;
    if parts.uri.path().ends_with("/stream") {
        let chunks: Vec<_> = spec["stream"]
            .as_str()
            .unwrap_or("")
            .as_bytes()
            .chunks(1)
            .map(|bytes| Ok::<_, std::io::Error>(Bytes::copy_from_slice(bytes)))
            .collect();
        Response::builder()
            .status(spec["streamStatus"].as_u64().unwrap_or(200) as u16)
            .header("content-type", "application/x-ndjson")
            .body(Body::from_stream(futures_util::stream::iter(chunks)))
            .unwrap()
    } else if parts.uri.path().ends_with("/cancel") {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::empty())
            .unwrap()
    } else {
        Response::builder().status(spec["deliveryStatus"].as_u64().unwrap_or(202)as u16).header("content-type","application/json").header("location","/must-not-follow").body(Body::from(serde_json::to_vec(spec.get("session").unwrap_or(&json!({"ok":true,"sessionId":"new-session","continuationToken":"initial-token"}))).unwrap())).unwrap()
    }
}
struct Fixture {
    origin: Url,
    capture: Arc<Capture>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new(spec: Value) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let capture = Arc::new(Capture {
            spec,
            requests: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        });
        let app = Router::new().fallback(serve).with_state(capture.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            origin,
            capture,
            server,
        }
    }
    fn options(&self) -> Options {
        Options {
            base_url: self.origin.clone(),
            channel_secret: SECRET.into(),
            capability_secret: SECRET.into(),
            model_secret: SECRET.into(),
            peer_origin: None,
            peer_identity: None,
            now: Arc::new(|| NOW),
        }
    }
    fn runtime(&self) -> EveRuntime {
        EveRuntime::new(self.options()).unwrap()
    }
}
fn context(checkpoint: Arc<dyn Checkpoint>) -> Context {
    Context {
        thread_id: "00000000-0000-4000-8000-000000000002".into(),
        run_id: RUN.into(),
        identity: Identity {
            workspace_id: "workspace-fixture".into(),
            user_id: "user-fixture".into(),
            workspace_role: "owner".into(),
        },
        model: json!({"connectionId":"00000000-0000-4000-8000-000000000003","provider":"openai","modelId":"gpt-fixture"}),
        reasoning_effort: "high".into(),
        deadline_ms: NOW * 1000 + 900000,
        runtime_session_id: None,
        correlation_id: Some("correlation-fixture".into()),
        checkpoint,
    }
}
#[tokio::test]
async fn runtime_http_delivery_recovery_checkpoints_and_events_match_source() {
    let data: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for case in data["eve"]["flows"].as_array().unwrap() {
        let spec = &case["spec"];
        let fixture = Fixture::new(spec.clone()).await;
        let runtime = fixture.runtime();
        let checkpoints = Arc::new(Checkpoints {
            values: Mutex::new(Vec::new()),
            fail_at: spec["failCheckpoint"].as_u64().unwrap_or(0) as usize,
        });
        let mut context = context(checkpoints.clone());
        context.runtime_session_id = spec
            .get("cursor")
            .map(|c| URL_SAFE_NO_PAD.encode(serde_json::to_vec(c).unwrap()));
        let mut stream = match spec["mode"].as_str() {
            Some("resume") => runtime.resume(
                context,
                vec![json!({"requestId":"request-fixture","optionId":"approve"})],
            ),
            Some("reconnect") => runtime.reconnect(context),
            _ => runtime.start(
                context,
                "Hello".into(),
                spec["attachments"].as_array().cloned().unwrap_or_default(),
            ),
        };
        let mut events = Vec::new();
        let mut error = false;
        while let Some(event) = stream.next().await {
            match event {
                Ok(event) => events.push(event),
                Err(_) => {
                    error = true;
                    break;
                }
            }
        }
        assert_eq!(error, case["error"], "{}", spec["name"]);
        assert_eq!(json!(events), case["events"], "{}", spec["name"]);
        assert_eq!(
            json!(*checkpoints.values.lock().unwrap()),
            case["checkpoints"],
            "{}",
            spec["name"]
        );
        assert_eq!(
            json!(*fixture.capture.requests.lock().unwrap()),
            case["requests"],
            "{}",
            spec["name"]
        );
    }
}
fn channel(headers: &HeaderMap) -> (String, Value) {
    let token = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    let parts: Vec<_> = token.split('.').collect();
    assert_eq!(parts.len(), 3);
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
        .unwrap();
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header, json!({"alg":"HS256","typ":"JWT"}));
    (
        token.into(),
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap(),
    )
}
struct IdentityProvider(AtomicUsize);

#[tokio::test]
async fn superseded_stream_cannot_overwrite_or_release_current_cancellation_state() {
    for terminal in [false, true] {
        let mut body =
            "{\"type\":\"message.appended\",\"data\":{\"messageDelta\":\"Hello\"}}\n".to_string();
        if terminal {
            body.push_str("{\"type\":\"turn.failed\",\"data\":{}}\n");
        }
        let fixture = Fixture::new(json!({"stream":body})).await;
        let runtime = fixture.runtime();
        let ctx = context(Arc::new(Checkpoints::default()));
        let mut old = runtime.start(ctx.clone(), "Old".into(), vec![]);
        old.next().await.unwrap().unwrap();
        let mut current = runtime.start(ctx, "Current".into(), vec![]);
        current.next().await.unwrap().unwrap();
        if terminal {
            assert!(old.next().await.unwrap().is_err());
        } else {
            assert!(old.next().await.is_none());
        }
        runtime.cancel(RUN, None, None).await.unwrap();
        assert!(
            fixture.capture.requests.lock().unwrap().last().unwrap()["path"]
                .as_str()
                .unwrap()
                .ends_with("/cancel")
        );
        if terminal {
            assert_eq!(current.next().await.unwrap().unwrap()["type"], "run.failed");
        } else {
            assert!(current.next().await.is_none());
        }
        let before = fixture.capture.requests.lock().unwrap().len();
        runtime.cancel(RUN, None, None).await.unwrap();
        assert_eq!(fixture.capture.requests.lock().unwrap().len(), before);
    }
}
#[async_trait]
impl PeerIdentity for IdentityProvider {
    async fn token(&self) -> Result<String, Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok("fixture-platform-identity".into())
    }
}
#[tokio::test]
async fn runtime_tokens_bind_run_model_capabilities_and_cancellation_survives_restart() {
    let fixture = Fixture::new(
        json!({"stream":"{\"type\":\"message.appended\",\"data\":{\"messageDelta\":\"Hello\"}}\n"}),
    )
    .await;
    let identity = Arc::new(IdentityProvider(AtomicUsize::new(0)));
    let mut options = fixture.options();
    options.peer_origin = Some(fixture.origin.clone());
    options.peer_identity = Some(identity.clone());
    let runtime = EveRuntime::new(options).unwrap();
    let checkpoints = Arc::new(Checkpoints::default());
    let context = context(checkpoints.clone());
    let mut stream = runtime.start(context.clone(), "Hello".into(), Vec::new());
    assert!(stream.next().await.unwrap().is_ok());
    runtime.cancel(RUN, None, None).await.unwrap();
    let (token, payload) = {
        let headers = fixture.capture.headers.lock().unwrap();
        assert_eq!(headers.len(), 3);
        for header in &*headers {
            assert_eq!(
                header["x-vercel-trusted-oidc-idp-token"],
                "fixture-platform-identity"
            );
        }
        let (token, payload) = channel(&headers[0]);
        assert_eq!(channel(&headers[1]).0, token);
        assert_eq!(channel(&headers[2]).0, token);
        (token, payload)
    };
    assert_eq!(payload["workspaceId"], context.identity.workspace_id);
    assert_eq!(payload["sub"], context.identity.user_id);
    assert_eq!(payload["runId"], RUN);
    assert_eq!(payload["provider"], "openai");
    assert_eq!(payload["modelId"], "gpt-fixture");
    assert_eq!(payload["reasoningEffort"], "high");
    assert_eq!(payload["correlationId"], "correlation-fixture");
    assert_eq!(payload["iss"], "forge");
    assert_eq!(payload["aud"], "forge-agent-runtime");
    assert_eq!(payload["iat"], NOW);
    assert_eq!(payload["exp"], NOW + 900);
    let capability = tokens::verify(
        SECRET,
        Kind::Capability,
        payload["forgeCapabilityToken"].as_str().unwrap(),
        NOW,
    )
    .unwrap();
    assert_eq!(capability["runId"], RUN);
    assert_eq!(
        capability["capabilities"],
        json!([
            "teams.list",
            "teams.get",
            "workspace.describe",
            "teams.update",
            "artifacts.create"
        ])
    );
    assert_eq!(
        capability["scopes"],
        json!(["teams:read", "teams:write", "agents:write"])
    );
    let model = tokens::verify(
        SECRET,
        Kind::ModelAccess,
        payload["forgeModelAccessToken"].as_str().unwrap(),
        NOW,
    )
    .unwrap();
    assert_eq!(model["connectionId"], context.model["connectionId"]);
    assert_eq!(model["runId"], RUN);
    assert_eq!(model["modelId"], "gpt-fixture");
    assert!(!token.contains("fixture-platform-identity"));
    drop(stream);
    drop(runtime);
    let cursor: Cursor =
        serde_json::from_value(checkpoints.values.lock().unwrap().last().unwrap().clone()).unwrap();
    fixture
        .runtime()
        .cancel(RUN, Some(&cursor.encode()), Some(&context))
        .await
        .unwrap();
    let (_, cancel) = channel(fixture.capture.headers.lock().unwrap().last().unwrap());
    assert_eq!(
        cancel["forgeCapabilityToken"],
        "forge-cancellation-only-capability"
    );
    assert_eq!(
        cancel["forgeModelAccessToken"],
        "forge-cancellation-only-model-access"
    );
    assert_eq!(cancel["exp"], NOW + 120);
    assert_eq!(cancel["runId"], RUN);
    assert!(cancel.get("correlationId").is_none());
    assert!(
        tokens::verify(
            SECRET,
            Kind::Capability,
            cancel["forgeCapabilityToken"].as_str().unwrap(),
            NOW
        )
        .is_err()
    );
    assert_eq!(identity.0.load(Ordering::SeqCst), 3);
    fixture
        .runtime()
        .cancel(RUN, None, Some(&context))
        .await
        .unwrap();
    fixture
        .runtime()
        .cancel(RUN, Some(&cursor.encode()), None)
        .await
        .unwrap();
    assert_eq!(fixture.capture.requests.lock().unwrap().len(), 4);
}
#[tokio::test]
async fn runtime_rejects_redirects_and_does_not_request_identity_for_unreviewed_origins() {
    let fixture = Fixture::new(json!({"deliveryStatus":302})).await;
    let context = context(Arc::new(Checkpoints::default()));
    let mut stream = fixture
        .runtime()
        .start(context.clone(), "Hello".into(), Vec::new());
    assert!(stream.next().await.unwrap().is_err());
    assert_eq!(fixture.capture.requests.lock().unwrap().len(), 1);
    let identity = Arc::new(IdentityProvider(AtomicUsize::new(0)));
    let mut options = fixture.options();
    options.peer_origin = Some(Url::parse("https://unrelated.invalid").unwrap());
    options.peer_identity = Some(identity.clone());
    let runtime = EveRuntime::new(options).unwrap();
    let mut stream = runtime.start(context, "Hello".into(), Vec::new());
    assert!(stream.next().await.unwrap().is_err());
    assert_eq!(identity.0.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.capture.requests.lock().unwrap().len(), 1);
    let mut options = fixture.options();
    options.peer_identity = Some(identity);
    assert!(EveRuntime::new(options).is_err());
}

#[tokio::test]
async fn changing_back_to_eve_cannot_silently_replace_a_saved_native_conversation() {
    let fixture = Fixture::new(json!({})).await;
    let saved = Arc::new(Checkpoints::default());
    let mut ctx = context(saved.clone());
    ctx.runtime_session_id = Some(
        forge_server::native_runtime::Cursor {
            conversation_id: ctx.thread_id.parse().unwrap(),
            run_id: ctx.run_id.parse().unwrap(),
            previous_run_id: None,
            stream_index: 0,
            deadline_ms: ctx.deadline_ms,
        }
        .encode(),
    );
    assert!(
        fixture
            .runtime()
            .start(ctx, "Continue".into(), vec![])
            .next()
            .await
            .unwrap()
            .is_err()
    );
    assert!(fixture.capture.requests.lock().unwrap().is_empty());
    assert!(saved.values.lock().unwrap().is_empty());
}
