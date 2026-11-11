use super::*;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Request, State},
    http::StatusCode,
    response::Response as HttpResponse,
    routing::any,
};
use serde_json::Value;
use std::convert::Infallible;
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{Mutex as StdMutex, atomic::AtomicUsize},
};
#[derive(Default)]
struct World {
    definition: Option<Value>,
    current: String,
    snapshot: Option<String>,
    sessions: BTreeMap<String, String>,
    files: BTreeMap<String, BTreeMap<String, String>>,
    snapshots: BTreeMap<String, BTreeMap<String, String>>,
    sources: BTreeMap<String, String>,
    requests: Vec<Value>,
    serial: usize,
    mode: u8,
    creates: usize,
}
struct Fixture {
    world: Arc<StdMutex<World>>,
    factory: Factory,
    task: tokio::task::JoinHandle<()>,
    key: Uuid,
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
            "public-fixture-token-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
impl Fixture {
    async fn new() -> Self {
        let world = Arc::new(StdMutex::new(World::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint =
            Url::parse(&format!("http://{}/api/", listener.local_addr().unwrap())).unwrap();
        let app = Router::new()
            .fallback(any(handler))
            .with_state(world.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let factory = Factory::with_endpoint(
            Options {
                team_id: "team_fixture".into(),
                project_id: "prj_fixture".into(),
                lifetime_ms: 900_000,
            },
            Arc::new(Identity(AtomicUsize::new(0))),
            endpoint,
        )
        .unwrap();
        Self {
            world,
            factory,
            task,
            key: Uuid::new_v4(),
        }
    }
    fn options(&self, create: bool) -> WorkspaceOptions {
        WorkspaceOptions {
            key: self.key,
            create_if_missing: create,
            snapshot_retention_ms: 60_000,
        }
    }
    async fn open(&self, create: bool) -> Result<Arc<VercelSandbox>> {
        self.factory.open_workspace(self.options(create)).await
    }
    fn mode(&self, mode: u8) {
        self.world.lock().unwrap().mode = mode;
    }
    async fn wait_resume(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self
                    .world
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .any(|v| v["query"]["resume"] == "true")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}
fn response(status: StatusCode, value: Value) -> HttpResponse {
    HttpResponse::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}
fn session(world: &World, id: &str) -> Value {
    json!({"id":id,"status":world.sessions.get(id).unwrap(),"networkPolicy":{"mode":"deny-all"},"sourceSnapshotId":world.sources.get(id)})
}
fn named(world: &World) -> Value {
    let mut definition = world.definition.clone().unwrap();
    definition["currentSessionId"] = json!(world.current);
    definition["currentSnapshotId"] = json!(world.snapshot);
    let mut value =
        json!({"sandbox":definition,"session":session(world,&world.current),"routes":[]});
    match world.mode {
        1 => value["sandbox"]["name"] = json!("foreign-name"),
        2 => value["sandbox"]["persistent"] = json!(false),
        3 => value["sandbox"]["networkPolicy"]["mode"] = json!("allow-all"),
        4 => value["sandbox"]["snapshotExpiration"] = json!(0),
        5 => value["sandbox"]["tags"] = json!({}),
        6 => value["sandbox"]["currentSnapshotId"] = Value::Null,
        7 => value["session"]["sourceSnapshotId"] = json!("snap_other"),
        _ => {}
    }
    value
}
async fn handler(State(state): State<Arc<StdMutex<World>>>, request: Request) -> HttpResponse {
    let path = request.uri().path().to_owned();
    let method = request.method().to_string();
    let query: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let headers = request.headers().clone();
    let bytes = axum::body::to_bytes(request.into_body(), 5 * 1024 * 1024)
        .await
        .unwrap();
    let body = if bytes.is_empty()
        || headers
            .get("content-type")
            .is_some_and(|v| v == "application/gzip")
    {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    let mut world = state.lock().unwrap();
    world.requests.push(json!({"path":path,"method":method,"query":query,"body":body,"authorization":headers.get("authorization").unwrap().to_str().unwrap()}));
    if path == "/api/v2/sandboxes" && method == "POST" {
        assert!(world.definition.is_none(), "must not silently recreate");
        world.creates += 1;
        world.definition = Some(body);
        world.current = "sbx_1".into();
        world.serial = 1;
        world.sessions.insert("sbx_1".into(), "running".into());
        world.files.insert("sbx_1".into(), BTreeMap::new());
        if world.mode == 10 {
            world.mode = 0;
            return HttpResponse::builder()
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap();
        }
        return response(StatusCode::OK, named(&world));
    }
    if path.contains("/forge-rust-workspace-") {
        if world.definition.is_none() || world.mode == 9 {
            return response(StatusCode::NOT_FOUND, json!({}));
        }
        if query.get("resume").is_some_and(|v| v == "true") {
            if world.mode != 8 {
                assert_eq!(world.sessions[&world.current], "stopped");
                world.serial += 1;
                world.current = format!("sbx_{}", world.serial);
                let id = world.current.clone();
                let snapshot = world.snapshot.clone().unwrap();
                let files = world.snapshots[&snapshot].clone();
                world.files.insert(id.clone(), files);
                world.sources.insert(id.clone(), snapshot);
                world.sessions.insert(id, "running".into());
            }
            if world.mode == 11 {
                world.mode = 0;
                return HttpResponse::builder()
                    .header("content-type", "application/json")
                    .body(Body::from("{"))
                    .unwrap();
            }
            if world.mode == 12 {
                world.mode = 0;
                return HttpResponse::builder()
                    .header("content-type", "application/json")
                    .body(Body::from_stream(futures_util::stream::pending::<
                        std::result::Result<Bytes, Infallible>,
                    >()))
                    .unwrap();
            }
        }
        return response(StatusCode::OK, named(&world));
    }
    let suffix = path.strip_prefix("/api/v2/sandboxes/sessions/").unwrap();
    let (id, operation) = suffix.split_once('/').unwrap_or((suffix, ""));
    if operation == "stop" {
        if world.sessions[id] != "stopped" {
            world.sessions.insert(id.into(), "stopping".into());
            if world.current == id {
                let snapshot = format!("snap_{id}");
                let files = world.files[id].clone();
                world.snapshots.insert(snapshot.clone(), files);
                world.snapshot = Some(snapshot);
            }
        }
        if world.mode == 14 {
            world.mode = 0;
            return HttpResponse::builder()
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap();
        }
        return response(StatusCode::OK, json!({"session":session(&world,id)}));
    }
    if operation.is_empty() {
        let status = if world.mode == 13 {
            "failed"
        } else {
            match world.sessions[id].as_str() {
                "stopping" => "snapshotting",
                "snapshotting" => "stopped",
                v => v,
            }
        }
        .to_owned();
        world.sessions.insert(id.into(), status);
        return response(StatusCode::OK, json!({"session":session(&world,id)}));
    }
    if operation == "network-policy" {
        assert_eq!(body, json!({"mode":"deny-all"}));
        return response(StatusCode::OK, json!({"session":session(&world,id)}));
    }
    assert_eq!(world.sessions[id], "running", "retired VM cannot execute");
    if operation == "cmd" {
        let command =
            |exit: Option<i32>| json!({"id":"cmd_fixture","sessionId":id,"exitCode":exit});
        let data = format!(
            "{}\n{}\n",
            json!({"command":command(None)}),
            json!({"command":command(Some(0))})
        );
        return HttpResponse::builder()
            .header("content-type", "application/x-ndjson")
            .body(Body::from(data))
            .unwrap();
    }
    if operation == "fs/write" {
        let gzip = flate2::read::GzDecoder::new(bytes.as_ref());
        let mut archive = tar::Archive::new(gzip);
        let mut entries = archive.entries().unwrap();
        let mut entry = entries.next().unwrap().unwrap();
        let path = format!("/{}", entry.path().unwrap().to_string_lossy());
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        world.files.get_mut(id).unwrap().insert(path, content);
        return response(StatusCode::OK, json!({}));
    }
    if operation == "fs/read" {
        return match world.files[id].get(body["path"].as_str().unwrap()) {
            Some(content) => HttpResponse::builder()
                .header("content-type", "application/octet-stream")
                .body(Body::from(content.clone()))
                .unwrap(),
            None => response(StatusCode::NOT_FOUND, json!({})),
        };
    }
    panic!("unexpected {path}")
}
#[tokio::test]
async fn named_workspace_resumes_its_saved_files_under_a_new_provider_session() {
    let fixture = Fixture::new().await;
    let first = fixture.open(true).await.unwrap();
    first
        .write_text("/workspace/a", "saved content")
        .await
        .unwrap();
    let old = first.identity().to_owned();
    let second = fixture.open(false).await.unwrap();
    assert_ne!(second.identity(), old);
    assert_eq!(
        second.read_text("/workspace/a").await.unwrap(),
        Some("saved content".into())
    );
    // A late old-handle shutdown addresses only the old VM, never the new one.
    first.shutdown().await.unwrap();
    assert_eq!(
        fixture.world.lock().unwrap().sessions[second.identity()],
        "running"
    );
    assert_eq!(
        second.read_text("/workspace/a").await.unwrap(),
        Some("saved content".into())
    );
    second.shutdown().await.unwrap();
    let world = fixture.world.lock().unwrap();
    assert_eq!(world.creates, 1);
    assert_eq!(world.definition.as_ref().unwrap()["env"], json!({}));
    assert_eq!(
        world.definition.as_ref().unwrap()["snapshotExpiration"],
        60_000
    );
    assert_eq!(
        world.definition.as_ref().unwrap()["keepLastSnapshots"],
        json!({"count":1,"expiration":60_000,"deleteEvicted":true})
    );
    for request in &world.requests {
        assert_eq!(request["query"]["teamId"], "team_fixture");
        assert!(
            request["authorization"]
                .as_str()
                .unwrap()
                .starts_with("Bearer public-fixture-token-")
        );
        if request["query"]["resume"].is_string() {
            assert_eq!(request["query"]["projectId"], "prj_fixture");
        }
    }
    for id in [old, second.identity().into()] {
        let policy = world
            .requests
            .iter()
            .position(|v| v["path"] == format!("/api/v2/sandboxes/sessions/{id}/network-policy"))
            .unwrap();
        let command = world
            .requests
            .iter()
            .position(|v| v["path"] == format!("/api/v2/sandboxes/sessions/{id}/cmd"))
            .unwrap();
        assert!(policy < command);
    }
}
#[tokio::test]
async fn acknowledged_workspaces_and_expired_snapshots_are_never_recreated() {
    let fixture = Fixture::new().await;
    assert_eq!(fixture.open(false).await.err(), Some(MISSING));
    assert_eq!(fixture.world.lock().unwrap().creates, 0);
    let first = fixture.open(true).await.unwrap();
    fixture.mode(9);
    assert_eq!(fixture.open(false).await.err(), Some(MISSING));
    assert_eq!(fixture.world.lock().unwrap().creates, 1);
    fixture.mode(6);
    assert_eq!(fixture.open(false).await.err(), Some(MISSING));
    assert!(
        !fixture
            .world
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|v| v["query"]["resume"] == "true")
    );
    fixture.mode(0);
    first.shutdown().await.unwrap();
}
#[tokio::test]
async fn lost_creation_and_resume_acknowledgements_reconcile_by_journaled_name() {
    for mode in [10, 11, 14] {
        let fixture = Fixture::new().await;
        let first = if mode != 10 {
            Some(fixture.open(true).await.unwrap())
        } else {
            None
        };
        fixture.mode(mode);
        assert!(fixture.open(mode == 10).await.is_err());
        let recovered = fixture.open(mode == 10).await.unwrap();
        assert_eq!(fixture.world.lock().unwrap().creates, 1);
        if let Some(first) = first {
            first.shutdown().await.unwrap();
        }
        recovered
            .write_text("/workspace/a", "after recovery")
            .await
            .unwrap();
        recovered.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn mismatched_names_policies_and_retention_are_rejected_before_mutation() {
    for mode in [1, 2, 3, 4, 5] {
        let fixture = Fixture::new().await;
        let first = fixture.open(true).await.unwrap();
        let before = fixture.world.lock().unwrap().requests.len();
        fixture.mode(mode);
        assert!(fixture.open(false).await.is_err());
        let requests = fixture.world.lock().unwrap().requests[before..].to_vec();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], "GET");
        assert_eq!(requests[0]["query"]["resume"], "false");
        fixture.mode(0);
        first.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn replacement_requires_a_new_session_restored_from_the_exact_snapshot() {
    for mode in [7, 8, 13] {
        let fixture = Fixture::new().await;
        let first = fixture.open(true).await.unwrap();
        fixture.mode(mode);
        assert!(fixture.open(false).await.is_err());
        if mode == 7 {
            assert_ne!(fixture.world.lock().unwrap().sessions["sbx_2"], "running");
        }
        fixture.mode(0);
        first.shutdown().await.unwrap();
        assert_eq!(fixture.world.lock().unwrap().creates, 1);
    }
}
#[tokio::test]
async fn aborted_resume_leaves_a_reconcilable_name_without_detached_name_cleanup() {
    let fixture = Arc::new(Fixture::new().await);
    let first = fixture.open(true).await.unwrap();
    fixture.mode(12);
    let cloned = fixture.clone();
    let attempt = tokio::spawn(async move { cloned.open(false).await });
    fixture.wait_resume().await;
    attempt.abort();
    let _ = attempt.await;
    let next = fixture.open(false).await.unwrap();
    assert_eq!(next.identity(), "sbx_3");
    first.shutdown().await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        fixture.world.lock().unwrap().sessions[next.identity()],
        "running"
    );
    next.shutdown().await.unwrap();
}
#[tokio::test]
async fn invalid_persistence_options_do_not_contact_the_provider() {
    let fixture = Fixture::new().await;
    for retention in [0, 59_999, MAX_RETENTION + 1] {
        let mut options = fixture.options(true);
        options.snapshot_retention_ms = retention;
        assert!(fixture.factory.open_workspace(options).await.is_err());
    }
    let mut options = fixture.options(true);
    options.key = Uuid::nil();
    assert!(fixture.factory.open_workspace(options).await.is_err());
    assert!(fixture.world.lock().unwrap().requests.is_empty());
}
