use super::*;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Request, State},
    http::StatusCode,
    response::Response as HttpResponse,
    routing::any,
};
use futures_util::StreamExt;
use std::{
    convert::Infallible,
    io::Read,
    sync::{Mutex as StdMutex, atomic::AtomicUsize},
};

#[derive(Default)]
struct FixtureState {
    requests: StdMutex<Vec<Value>>,
    name: StdMutex<String>,
    mode: AtomicUsize,
    stops: AtomicUsize,
}
struct Fixture {
    state: Arc<FixtureState>,
    endpoint: Url,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        let state = Arc::new(FixtureState::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint =
            Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
        let app = Router::new()
            .fallback(any(handler))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            state,
            endpoint,
            task,
        }
    }
    fn factory(&self) -> Factory {
        Factory::with_endpoint(
            Options {
                team_id: "team_fixture".into(),
                project_id: "prj_fixture".into(),
                lifetime_ms: 1800000,
            },
            Arc::new(Identity(AtomicUsize::new(0))),
            self.endpoint.clone(),
        )
        .unwrap()
    }
    fn mode(&self, mode: usize) {
        self.state.mode.store(mode, Ordering::SeqCst);
    }
    async fn wait_path(&self, suffix: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self
                    .state
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|v| v["path"].as_str().unwrap().ends_with(suffix))
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
struct Identity(AtomicUsize);
#[async_trait]
impl PeerIdentity for Identity {
    async fn token(&self) -> Result<String> {
        Ok(format!(
            "public-sandbox-fixture-token-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
fn response(status: StatusCode, value: Value) -> HttpResponse {
    HttpResponse::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}
fn command(exit: Option<i32>) -> Value {
    json!({"id":"cmd_fixture","sessionId":"sbx_fixture","name":"bash","args":[],"cwd":"/workspace","exitCode":exit,"startedAt":0})
}
fn session(status: &str) -> Value {
    json!({"id":"sbx_fixture","status":status,"networkPolicy":{"mode":"deny-all"}})
}
async fn handler(State(state): State<Arc<FixtureState>>, request: Request) -> HttpResponse {
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    let method = request.method().to_string();
    let query = request.uri().query().unwrap_or("").to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 5 * 1024 * 1024)
        .await
        .unwrap();
    let mut captured = json!({"path":path,"method":method,"query":url::form_urlencoded::parse(query.as_bytes()).into_owned().collect::<std::collections::HashMap<_,_>>(),"headers":{}});
    for name in ["authorization", "content-type", "x-cwd"] {
        if let Some(value) = headers.get(name) {
            captured["headers"][name] = json!(value.to_str().unwrap());
        }
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else if headers
        .get("content-type")
        .is_some_and(|v| v == "application/gzip")
    {
        let gzip = flate2::read::GzDecoder::new(bytes.as_ref());
        let mut archive = tar::Archive::new(gzip);
        let mut entries = archive.entries().unwrap();
        let mut entry = entries.next().unwrap().unwrap();
        let path = entry.path().unwrap().to_string_lossy().into_owned();
        let mode = entry.header().mode().unwrap();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        assert!(entries.next().is_none());
        captured["archive"] = json!({"path":path,"mode":mode,"content":content});
        Value::Null
    } else {
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        captured["body"] = body.clone();
        body
    };
    state.requests.lock().unwrap().push(captured);
    let mode = state.mode.load(Ordering::SeqCst);
    if path == "/api/v2/sandboxes" {
        *state.name.lock().unwrap() = body["name"].as_str().unwrap().to_owned();
        if mode == 12 {
            return HttpResponse::new(Body::from_stream(futures_util::stream::pending::<
                std::result::Result<Bytes, Infallible>,
            >()));
        }
        return response(
            StatusCode::OK,
            json!({"sandbox":{"name":if mode==11 {"wrong".to_owned()}else{state.name.lock().unwrap().clone()}},"session":session("running")}),
        );
    }
    if path.ends_with("/stop") {
        let count = state.stops.fetch_add(1, Ordering::SeqCst);
        if mode == 14 && count == 0 {
            return response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"message":"sk-private-stop-failure"}),
            );
        }
        return response(StatusCode::OK, json!({"session":session("stopped")}));
    }
    if path.ends_with("/network-policy") {
        let mut value = session("running");
        if mode == 1 {
            value["networkPolicy"]["mode"] = json!("allow-all");
        }
        return response(StatusCode::OK, json!({"session":value}));
    }
    if path.ends_with("/fs/write") {
        return if mode == 10 {
            response(
                StatusCode::FORBIDDEN,
                json!({"message":"sk-private-write-failure"}),
            )
        } else {
            response(StatusCode::OK, json!({}))
        };
    }
    if path.ends_with("/cmd") {
        let bootstrap = body["sudo"] == true;
        if !bootstrap && mode == 9 {
            return HttpResponse::builder()
                .status(StatusCode::TEMPORARY_REDIRECT)
                .header("location", "/leak")
                .body(Body::from("sk-private-redirect"))
                .unwrap();
        }
        let mut lines = vec![json!({"command":command(None)})];
        let mut tail = String::new();
        if !bootstrap {
            match mode {
                2 => {
                    tail = "not-json\n".into();
                }
                4 => {}
                5 => {
                    let mut c = command(Some(0));
                    c["sessionId"] = json!("other-session");
                    lines.push(json!({"command":c}));
                }
                6 => {
                    lines.push(json!({"stream":"stdout","data":"x".repeat(OUTPUT_LIMIT+1)}));
                }
                7 => {
                    tail = "x".repeat(LINE_LIMIT + 1);
                }
                8 => {
                    lines.push(json!({"stream":"error","data":{"code":"private","message":"sk-private-stream-error"}}));
                }
                3 => {}
                _ => {
                    lines.push(json!({"stream":"stdout","data":"fixture 😀\n"}));
                    lines.push(json!({"stream":"stderr","data":"note\n"}));
                    lines.push(json!({"command":command(Some(0))}));
                }
            }
        } else {
            lines.push(json!({"command":command(Some(if mode==13 {1}else{0}))}));
        }
        let mut bytes = lines
            .into_iter()
            .map(|v| v.to_string() + "\n")
            .collect::<String>()
            .into_bytes();
        bytes.extend_from_slice(tail.as_bytes());
        let chunks = bytes
            .chunks(if mode == 0 { 1 } else { 16384 })
            .map(Bytes::copy_from_slice)
            .collect::<Vec<_>>();
        let stream = futures_util::stream::iter(chunks.into_iter().map(Ok::<_, Infallible>));
        let body = if !bootstrap && mode == 3 {
            Body::from_stream(stream.chain(futures_util::stream::pending()))
        } else {
            Body::from_stream(stream)
        };
        return HttpResponse::builder()
            .header("content-type", "application/x-ndjson")
            .body(body)
            .unwrap();
    }
    if method == "GET" && path.starts_with("/api/v2/sandboxes/forge-rust-") {
        return response(
            StatusCode::OK,
            json!({"sandbox":{"name":state.name.lock().unwrap().clone()},"session":session("running")}),
        );
    }
    response(
        StatusCode::NOT_FOUND,
        json!({"error":"unexpected fixture request"}),
    )
}

#[tokio::test]
async fn native_sandbox_matches_installed_sdk_protocol_and_keeps_credentials_outside_vm() {
    let source: Value =
        serde_json::from_str(include_str!("../../../../reference-fixtures.json")).unwrap();
    let source = &source["sandboxProtocol"];
    let fixture = Fixture::new().await;
    let sandbox = fixture.factory().create().await.unwrap();
    let output = sandbox.run("echo fixture").await.unwrap();
    assert_eq!(
        json!({"stdout":output.stdout,"stderr":output.stderr,"exitCode":output.exit_code}),
        source["output"]
    );
    sandbox
        .write("programs/fixture/input.json", "{\"value\":\"😀\"}")
        .await
        .unwrap();
    sandbox.remove("programs/fixture").await.unwrap();
    sandbox.shutdown().await.unwrap();
    let actual = fixture.state.requests.lock().unwrap();
    let mut create = actual[0]["body"].clone();
    create["name"] = source["requests"][0]["body"]["name"].clone();
    assert_eq!(create, source["requests"][0]["body"]);
    assert_eq!(actual[0]["query"], source["requests"][0]["query"]);
    let command = actual
        .iter()
        .find(|v| v["body"]["args"] == json!(["-lc", "echo fixture"]))
        .unwrap();
    let mut request = command["body"].clone();
    request.as_object_mut().unwrap().remove("timeout");
    assert_eq!(request, source["requests"][2]["body"]);
    let file = actual.iter().find(|v| v.get("archive").is_some()).unwrap();
    let original = &source["requests"][3];
    assert_eq!(file["archive"]["content"], original["archive"]["content"]);
    assert_eq!(file["archive"]["mode"], original["archive"]["mode"]);
    assert_eq!(
        format!(
            "{}/{}",
            file["headers"]["x-cwd"].as_str().unwrap(),
            file["archive"]["path"].as_str().unwrap()
        ),
        format!("/{}", original["archive"]["path"].as_str().unwrap())
    );
    for (n, req) in actual.iter().enumerate() {
        assert_eq!(
            req["headers"]["authorization"],
            format!("Bearer public-sandbox-fixture-token-{n}")
        );
        assert!(
            !req["body"]
                .to_string()
                .contains("public-sandbox-fixture-token")
        );
        if req["body"].get("command").is_some() {
            assert_eq!(req["body"]["env"], json!({}));
        }
    }
    assert_eq!(fixture.state.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn provider_must_acknowledge_denied_network_and_bootstrap_before_tool_execution() {
    for mode in [1, 13] {
        let fixture = Fixture::new().await;
        fixture.mode(mode);
        assert!(fixture.factory().create().await.is_err());
        fixture.wait_path("/stop").await;
        let requests = fixture.state.requests.lock().unwrap();
        assert!(!requests.iter().any(|v|v["path"].as_str().unwrap().ends_with("/cmd")&&v["body"]["sudo"]!=true));
    }
}
#[tokio::test]
async fn malformed_truncated_oversized_and_redirected_streams_revoke_remote_execution() {
    for mode in [2, 4, 5, 6, 7, 8, 9] {
        let fixture = Fixture::new().await;
        let sandbox = fixture.factory().create().await.unwrap();
        fixture.mode(mode);
        let error = sandbox
            .run("echo fixture")
            .await
            .err()
            .expect("invalid provider stream accepted");
        assert!(!error.to_string().contains("sk-private"));
        sandbox.shutdown().await.unwrap();
        assert!(sandbox.run("must not execute").await.is_err());
        assert!(
            !fixture
                .state
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["path"] == "/leak")
        );
        assert_eq!(fixture.state.stops.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn cancelling_in_flight_command_stops_sandbox_and_prevents_new_writes() {
    let fixture = Fixture::new().await;
    let sandbox = fixture.factory().create().await.unwrap();
    fixture.mode(3);
    fixture.state.requests.lock().unwrap().clear();
    let task = {
        let sandbox = sandbox.clone();
        tokio::spawn(async move { sandbox.run("sleep forever").await })
    };
    fixture.wait_path("/cmd").await;
    task.abort();
    let _ = task.await;
    fixture.wait_path("/stop").await;
    assert!(
        sandbox
            .write("later", "must never reach provider")
            .await
            .is_err()
    );
    sandbox.shutdown().await.unwrap();
    assert_eq!(fixture.state.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn ambiguous_or_interrupted_creation_is_reconciled_by_name_without_resuming() {
    for mode in [11, 12] {
        let fixture = Fixture::new().await;
        fixture.mode(mode);
        let factory = fixture.factory();
        let task = tokio::spawn(async move { factory.create().await });
        fixture.wait_path("/sandboxes").await;
        if mode == 12 {
            task.abort();
            let _ = task.await;
        } else {
            assert!(task.await.unwrap().is_err());
        }
        fixture.wait_path("/stop").await;
        let requests = fixture.state.requests.lock().unwrap();
        let lookup = requests.iter().find(|v| v["method"] == "GET").unwrap();
        assert_eq!(lookup["query"]["projectId"], "prj_fixture");
        assert!(lookup["query"].get("resume").is_none());
        assert_eq!(requests[0]["body"]["timeout"], 1800000);
    }
}
#[tokio::test]
async fn files_are_bounded_and_relative_and_write_errors_close_the_sandbox() {
    let fixture = Fixture::new().await;
    let sandbox = fixture.factory().create().await.unwrap();
    let before = fixture.state.requests.lock().unwrap().len();
    for path in [
        "",
        "/etc/private",
        "../escape",
        "a/../b",
        ".",
        "./",
        "a\nb",
        "a;evil",
        "a\\b",
    ] {
        assert!(sandbox.write(path, "private").await.is_err());
        assert!(sandbox.remove(path).await.is_err());
    }
    assert!(
        sandbox
            .write("input", "x".repeat(4 * 1024 * 1024 + 1).as_str())
            .await
            .is_err()
    );
    assert_eq!(fixture.state.requests.lock().unwrap().len(), before);
    fixture.mode(10);
    assert_eq!(sandbox.write("input", "content").await.unwrap_err(), FAILED);
    sandbox.shutdown().await.unwrap();
}
#[tokio::test]
async fn shutdown_failures_remain_revoked_and_can_be_retried() {
    let fixture = Fixture::new().await;
    let sandbox = fixture.factory().create().await.unwrap();
    fixture.mode(14);
    assert_eq!(sandbox.shutdown().await.unwrap_err(), FAILED);
    assert!(sandbox.run("echo forbidden").await.is_err());
    sandbox.shutdown().await.unwrap();
    assert_eq!(fixture.state.stops.load(Ordering::SeqCst), 2);
    drop(sandbox);
    tokio::task::yield_now().await;
    assert_eq!(fixture.state.stops.load(Ordering::SeqCst), 2);
    assert!(
        Factory::new(
            Options {
                team_id: "team_fixture".into(),
                project_id: "prj_fixture".into(),
                lifetime_ms: 1_800_001
            },
            Arc::new(Identity(AtomicUsize::new(0)))
        )
        .is_err()
    );
}
