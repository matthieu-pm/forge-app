use async_trait::async_trait;
use forge_agent_runtime::{
    Error, Result,
    auth::Channel,
    callback::{Capabilities, Request},
    contracts,
    execution::{self, Features},
    sandbox::{Cancellation, Execution, Sandbox},
};
use forge_core::agents::tokens::{self, Kind};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::time::{Duration, sleep};

static DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap()
});
const SECRET: &str = "public-runtime-fixture-secret-1234567890";
const RUN: &str = "00000000-0000-4000-8000-000000000001";
fn channel() -> Channel {
    Channel::verify(
        SECRET,
        DATA["runtimeService"]["auth"][0]["authorization"]
            .as_str()
            .unwrap(),
        1793491200,
    )
    .unwrap()
}
#[test]
fn channel_authentication_matches_source_and_separates_token_audiences() {
    for case in DATA["runtimeService"]["auth"].as_array().unwrap() {
        let result = Channel::verify(
            case["secret"].as_str().unwrap(),
            case["authorization"].as_str().unwrap(),
            case["now"].as_i64().unwrap(),
        );
        let expected = &case["result"];
        assert_eq!(result.is_ok(), !expected.is_null(), "{case}");
        if let Ok(channel) = result {
            assert_eq!(channel.principal_id(), expected["principalId"]);
            for (actual, key) in [
                (channel.workspace_id(), "workspaceId"),
                (channel.run_id(), "runId"),
                (channel.correlation_id(), "correlationId"),
                (channel.provider(), "provider"),
                (channel.model_id(), "modelId"),
                (channel.reasoning_effort(), "reasoningEffort"),
                (channel.model_access_token(), "forgeModelAccessToken"),
            ] {
                assert_eq!(actual, expected["attributes"][key]);
            }
        }
    }
    let authorization = DATA["runtimeService"]["auth"][0]["authorization"]
        .as_str()
        .unwrap();
    for kind in [
        Kind::Capability,
        Kind::LocalIngest,
        Kind::ModelAccess,
        Kind::Artifact,
    ] {
        assert!(
            tokens::verify(
                SECRET,
                kind,
                authorization.strip_prefix("Bearer ").unwrap(),
                1793491200
            )
            .is_err()
        );
    }
    assert!(Channel::verify("short-key", authorization, 1793491200).is_err());
}
#[test]
fn code_and_manifest_contracts_match_source() {
    for (field, parser) in [
        ("code", contracts::run_code as fn(Value) -> _),
        ("manifests", contracts::manifest_entry),
    ] {
        for case in DATA["runtimeService"][field].as_array().unwrap() {
            let result = parser(case["input"].clone());
            assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
            if let Ok(result) = result {
                assert_eq!(result, case["result"], "{case}");
            }
        }
    }
    let huge = json!({"language":"javascript","code":"42","files":(0..5).map(|n| json!({"path":format!("input-{n}"),"content":"x".repeat(500000)})).collect::<Vec<_>>()});
    assert!(contracts::run_code(huge).is_err());
    assert!(contracts::run_code(json!({"language":"shell","code":"x".repeat(100001)})).is_err());
}

#[derive(Default)]
struct FakeSandbox {
    outputs: Mutex<VecDeque<Execution>>,
    writes: Mutex<Vec<(String, String)>>,
    commands: Mutex<Vec<String>>,
    removed: Mutex<Vec<String>>,
    wait: Option<Duration>,
    writing_error: bool,
    cleanup_error: bool,
}
impl FakeSandbox {
    fn with_outputs(outputs: impl IntoIterator<Item = String>) -> Self {
        Self {
            outputs: Mutex::new(
                outputs
                    .into_iter()
                    .map(|stdout| Execution {
                        stdout,
                        stderr: String::new(),
                        exit_code: 0,
                    })
                    .collect(),
            ),
            ..Self::default()
        }
    }
    fn states(&self) -> Value {
        json!(
            self.writes
                .lock()
                .unwrap()
                .iter()
                .filter(|(p, _)| p.ends_with("/state.json"))
                .map(|(_, v)| serde_json::from_str::<Value>(v).unwrap())
                .collect::<Vec<_>>()
        )
    }
}
#[async_trait]
impl Sandbox for FakeSandbox {
    async fn write(&self, path: &str, content: &str) -> Result<()> {
        self.writes
            .lock()
            .unwrap()
            .push((path.into(), content.into()));
        if self.writing_error {
            return Err(Error("Fixture write failed."));
        }
        Ok(())
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        self.commands.lock().unwrap().push(command.into());
        if let Some(wait) = self.wait {
            sleep(wait).await;
        }
        self.outputs
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(Error("Fixture has no output."))
    }
    async fn remove(&self, path: &str) -> Result<()> {
        self.removed.lock().unwrap().push(path.into());
        if self.cleanup_error {
            return Err(Error("Fixture cleanup failed."));
        }
        Ok(())
    }
}
#[derive(Default)]
struct FakeCapabilities {
    responses: Mutex<VecDeque<Value>>,
    requests: Mutex<Vec<Value>>,
    wait: Option<Duration>,
    cancel: Option<Cancellation>,
}
#[async_trait]
impl Capabilities for FakeCapabilities {
    async fn call(&self, channel: &Channel, req: Request) -> Result<Value> {
        assert_eq!(channel.run_id(), RUN);
        let mut value = json!({"id":req.id,"version":req.version,"input":req.input});
        if let Some(key) = req.idempotency_key {
            value["idempotencyKey"] = json!(key);
        }
        self.requests.lock().unwrap().push(value);
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        if let Some(wait) = self.wait {
            sleep(wait).await;
        }
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Value::Null))
    }
}
fn program() -> Value {
    json!({"language":"javascript","code":"return 42","timeoutMs":1000,"capabilityManifest":[{"id":"teams.list","version":"1","maximumCalls":1}]})
}
fn code() -> Value {
    json!({"language":"typescript","code":"console.log(42)","files":[{"path":"input/data.json","content":"{\"value\":6}"}],"timeoutMs":1000})
}
fn call(n: u64, id: &str) -> String {
    format!(
        "__FORGE_CALL__{}\n",
        json!({"callIndex":n,"capabilityId":id,"input":{}})
    )
}

#[tokio::test]
async fn program_replays_match_nine_source_executions_without_copying_credentials() {
    for case in DATA["runtimeService"]["programFlows"].as_array().unwrap() {
        let sandbox = Arc::new(FakeSandbox::with_outputs(
            case["outputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned()),
        ));
        let capabilities = FakeCapabilities {
            responses: Mutex::new(
                case["responses"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect(),
            ),
            ..FakeCapabilities::default()
        };
        let result = execution::execute_program(
            sandbox.clone(),
            &capabilities,
            &channel(),
            case["input"].clone(),
            Features::default(),
            &Cancellation::default(),
        )
        .await;
        assert_eq!(result.is_err(), case["failed"].as_bool().unwrap(), "{case}");
        if let Ok(result) = result {
            assert_eq!(result, case["result"]);
        }
        assert_eq!(
            json!(*capabilities.requests.lock().unwrap()),
            case["requests"]
        );
        assert_eq!(sandbox.states(), case["states"]);
        assert_eq!(
            json!(sandbox.commands.lock().unwrap().len()),
            case["executions"]
        );
        assert_eq!(
            json!(sandbox.removed.lock().unwrap().len()),
            case["removed"]
        );
        for (_, content) in sandbox.writes.lock().unwrap().iter() {
            for secret in [
                SECRET,
                "public-fixture-capability-token",
                "public-fixture-model-token",
            ] {
                assert!(!content.contains(secret));
            }
        }
    }
}
#[tokio::test]
async fn forged_markers_cannot_exceed_per_capability_budgets_or_write_without_keys() {
    let mut input = program();
    input["capabilityManifest"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"teams.get","version":"1","maximumCalls":3}));
    let sandbox = Arc::new(FakeSandbox::with_outputs([
        call(0, "teams.list"),
        call(1, "teams.list"),
    ]));
    let capabilities = FakeCapabilities::default();
    let result = execution::execute_program(
        sandbox.clone(),
        &capabilities,
        &channel(),
        input,
        Features::default(),
        &Cancellation::default(),
    )
    .await;
    assert_eq!(
        result.unwrap_err(),
        Error("Program exceeded its declared capability call budget.")
    );
    assert_eq!(capabilities.requests.lock().unwrap().len(), 1);
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    let mut input = program();
    input["capabilityManifest"][0]["id"] = json!("teams.update");
    assert!(execution::needs_approval(&input));
    let sandbox = Arc::new(FakeSandbox::with_outputs([call(0, "teams.update")]));
    let capabilities = FakeCapabilities::default();
    assert_eq!(
        execution::execute_program(
            sandbox.clone(),
            &capabilities,
            &channel(),
            input,
            Features::default(),
            &Cancellation::default()
        )
        .await
        .unwrap_err(),
        Error("Program writes require an idempotency key.")
    );
    assert!(capabilities.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn code_runs_with_private_files_and_cleans_up_every_error_path() {
    let sandbox = Arc::new(FakeSandbox::with_outputs(["42\n".into()]));
    assert_eq!(
        execution::run_code(
            sandbox.clone(),
            code(),
            Features::default(),
            &Cancellation::default()
        )
        .await
        .unwrap(),
        json!({"language":"typescript","exitCode":0,"stdout":"42\n","stderr":""})
    );
    assert!(
        sandbox.commands.lock().unwrap()[0]
            .starts_with("node --experimental-strip-types /workspace/code/")
    );
    assert_eq!(sandbox.writes.lock().unwrap().len(), 2);
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    for sandbox in [
        FakeSandbox::with_outputs(["😀".repeat(40000)]),
        FakeSandbox {
            writing_error: true,
            ..FakeSandbox::default()
        },
        FakeSandbox {
            cleanup_error: true,
            ..FakeSandbox::with_outputs(["ok".into()])
        },
    ] {
        let sandbox = Arc::new(sandbox);
        assert!(
            execution::run_code(
                sandbox.clone(),
                code(),
                Features::default(),
                &Cancellation::default()
            )
            .await
            .is_err()
        );
        assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    }
    let sandbox = Arc::new(FakeSandbox::default());
    let mut input = code();
    input["files"][0]["path"] = json!("../private");
    assert!(
        execution::run_code(
            sandbox.clone(),
            input,
            Features::default(),
            &Cancellation::default()
        )
        .await
        .is_err()
    );
    assert!(sandbox.writes.lock().unwrap().is_empty());
}
#[tokio::test(start_paused = true)]
async fn one_deadline_covers_all_passes_and_callbacks_and_cancellation_cleans_up() {
    let sandbox = Arc::new(FakeSandbox {
        wait: Some(Duration::from_millis(600)),
        ..FakeSandbox::with_outputs([
            call(0, "teams.list"),
            "__FORGE_OUTPUT__{\"result\":42}".into(),
        ])
    });
    let callbacks = FakeCapabilities {
        wait: Some(Duration::from_millis(300)),
        ..FakeCapabilities::default()
    };
    assert_eq!(
        execution::execute_program(
            sandbox.clone(),
            &callbacks,
            &channel(),
            program(),
            Features::default(),
            &Cancellation::default()
        )
        .await
        .unwrap_err(),
        Error("Sandbox execution timed out.")
    );
    assert_eq!(sandbox.commands.lock().unwrap().len(), 2);
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    let sandbox = Arc::new(FakeSandbox {
        wait: Some(Duration::from_secs(10)),
        ..FakeSandbox::with_outputs(["ok".into()])
    });
    let cancellation = Cancellation::default();
    let cancel = cancellation.clone();
    tokio::spawn(async move {
        sleep(Duration::from_millis(100)).await;
        cancel.cancel();
    });
    assert_eq!(
        execution::run_code(sandbox.clone(), code(), Features::default(), &cancellation)
            .await
            .unwrap_err(),
        Error("Sandbox execution cancelled.")
    );
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    assert!(
        execution::run_code(sandbox.clone(), code(), Features::default(), &cancellation)
            .await
            .is_err()
    );
    assert_eq!(sandbox.commands.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn dropping_execution_cleans_up_and_disabled_tools_never_create_files() {
    let sandbox = Arc::new(FakeSandbox {
        wait: Some(Duration::from_secs(10)),
        ..FakeSandbox::default()
    });
    let work = {
        let sandbox = sandbox.clone();
        tokio::spawn(async move {
            execution::run_code(
                sandbox,
                code(),
                Features::default(),
                &Cancellation::default(),
            )
            .await
        })
    };
    while sandbox.commands.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    work.abort();
    let _ = work.await;
    for _ in 0..100 {
        if !sandbox.removed.lock().unwrap().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    let sandbox = Arc::new(FakeSandbox::default());
    let features = Features {
        code_mode: false,
        ..Features::default()
    };
    assert!(
        execution::run_code(sandbox.clone(), code(), features, &Cancellation::default())
            .await
            .is_err()
    );
    assert!(
        execution::execute_program(
            sandbox.clone(),
            &FakeCapabilities::default(),
            &channel(),
            program(),
            features,
            &Cancellation::default()
        )
        .await
        .is_err()
    );
    assert!(sandbox.writes.lock().unwrap().is_empty());
}

// Runs only repository-owned fixture programs. This adapter is test-only and is
// never selectable by production runtime configuration.
struct LocalFixture {
    root: std::path::PathBuf,
}
#[async_trait]
impl Sandbox for LocalFixture {
    async fn write(&self, path: &str, content: &str) -> Result<()> {
        let file = self.root.join(path);
        tokio::fs::create_dir_all(file.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(file, content)
            .await
            .map_err(|_| Error("Fixture write failed."))
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        let args = command
            .split(' ')
            .skip(1)
            .map(|s| s.replace("/workspace/", &format!("{}/", self.root.display())))
            .collect::<Vec<_>>();
        // Resolve the fixture binary before clearing the child environment;
        // macOS's default exec search path does not include Homebrew.
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join("node"))
            .find(|path| path.is_file())
            .expect("Node is required for the repository-owned runner fixture");
        let result = tokio::process::Command::new(node)
            .args(args)
            .env_clear()
            .kill_on_drop(true)
            .current_dir(&self.root)
            .output()
            .await
            .map_err(|_| Error("Fixture process failed."))?;
        Ok(Execution {
            stdout: String::from_utf8_lossy(&result.stdout).into(),
            stderr: String::from_utf8_lossy(&result.stderr).into(),
            exit_code: result.status.code().unwrap_or(1),
        })
    }
    async fn remove(&self, path: &str) -> Result<()> {
        tokio::fs::remove_dir_all(self.root.join(path))
            .await
            .map_err(|_| Error("Fixture cleanup failed."))
    }
}
impl Drop for LocalFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[tokio::test]
async fn actual_javascript_runner_replays_and_rejects_nested_input_divergence() {
    let sandbox = Arc::new(LocalFixture {
        root: std::env::temp_dir().join(format!(
            "forge-rust-program-fixture-{}",
            uuid::Uuid::new_v4()
        )),
    });
    let capabilities = FakeCapabilities {
        responses: Mutex::new(VecDeque::from([json!({"items":[{"name":"Forge"}]})])),
        ..FakeCapabilities::default()
    };
    let mut input = program();
    input["timeoutMs"] = json!(10000);
    input["code"] = json!(
        "const page=await forge.call('teams.list',{limit:1});return page.items.map(team=>team.name)"
    );
    let result = execution::execute_program(
        sandbox.clone(),
        &capabilities,
        &channel(),
        input.clone(),
        Features::default(),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert_eq!(result["result"], json!(["Forge"]));
    assert_eq!(capabilities.requests.lock().unwrap().len(), 1);
    let capabilities = FakeCapabilities::default();
    input["code"] = json!("return await forge.call('teams.list',{nested:{pid:process.pid}})");
    assert!(
        execution::execute_program(
            sandbox.clone(),
            &capabilities,
            &channel(),
            input,
            Features::default(),
            &Cancellation::default()
        )
        .await
        .is_err()
    );
    assert_eq!(capabilities.requests.lock().unwrap().len(), 1);
    let mut dirs = tokio::fs::read_dir(sandbox.root.join("programs"))
        .await
        .unwrap();
    assert!(dirs.next_entry().await.unwrap().is_none());
}

#[tokio::test]
async fn callbacks_bind_identity_encode_paths_and_redact_private_failures() {
    use axum::{
        Router,
        body::Body,
        extract::{Request as HttpRequest, State},
        http::{HeaderMap, StatusCode},
        response::Response,
        routing::any,
    };
    use forge_agent_runtime::callback::{HttpCapabilities, PeerIdentity};
    type Captured = Arc<Mutex<Vec<(String, HeaderMap, Value)>>>;
    async fn handler(State(captured): State<Captured>, req: HttpRequest) -> Response {
        let uri = req.uri().to_string();
        let headers = req.headers().clone();
        let bytes = axum::body::to_bytes(req.into_body(), 10000).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        captured.lock().unwrap().push((uri, headers, body.clone()));
        let (status, bytes) = match body["input"]["case"].as_str().unwrap_or("") {
            "redirect" => (StatusCode::FOUND, "private redirect body".into()),
            "failure" => (StatusCode::BAD_REQUEST, "sk-private-provider-error".into()),
            "oversize" => (StatusCode::OK, "x".repeat(4 * 1024 * 1024 + 1)),
            "invalid" => (StatusCode::OK, "sk-private-not-json".into()),
            _ => (StatusCode::OK, "{\"items\":[],\"nextCursor\":null}".into()),
        };
        Response::builder()
            .status(status)
            .header("location", "http://127.0.0.1:9/leak")
            .body(Body::from(bytes))
            .unwrap()
    }
    struct Identity(AtomicUsize);
    #[async_trait]
    impl PeerIdentity for Identity {
        async fn token(&self) -> Result<String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok("public-peer-identity-fixture".into())
        }
    }
    let captured: Captured = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let app = Router::new()
        .fallback(any(handler))
        .with_state(captured.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let identity = Arc::new(Identity(AtomicUsize::new(0)));
    assert!(
        HttpCapabilities::new(
            origin.clone(),
            Some((
                url::Url::parse("https://wrong.test").unwrap(),
                identity.clone()
            ))
        )
        .is_err()
    );
    assert_eq!(identity.0.load(Ordering::SeqCst), 0);
    let client = HttpCapabilities::new(origin.clone(), Some((origin, identity.clone()))).unwrap();
    let request = |case: &str| Request {
        id: "teams.get/slash?probe".into(),
        version: "1".into(),
        input: json!({"case":case}),
        idempotency_key: Some("fixture-key".into()),
    };
    assert_eq!(
        client.call(&channel(), request("ok")).await.unwrap(),
        json!({"items":[],"nextCursor":null})
    );
    for case in ["redirect", "failure", "oversize", "invalid"] {
        assert_eq!(
            client.call(&channel(), request(case)).await.unwrap_err(),
            Error("Forge capability request failed.")
        );
    }
    let requests = captured.lock().unwrap();
    assert_eq!(requests.len(), 5);
    let (uri, headers, body) = &requests[0];
    assert_eq!(uri, "/api/agent/capabilities/teams.get%2Fslash%3Fprobe");
    assert_eq!(
        headers["authorization"],
        "Bearer public-fixture-capability-token"
    );
    assert_eq!(headers["x-forge-agent-run-id"], RUN);
    assert_eq!(headers["x-correlation-id"], RUN);
    assert_eq!(headers["x-forge-workspace-id"], "fixture-workspace");
    assert_eq!(
        headers["x-vercel-trusted-oidc-idp-token"],
        "public-peer-identity-fixture"
    );
    assert_eq!(
        body,
        &json!({"version":"1","input":{"case":"ok"},"idempotencyKey":"fixture-key"})
    );
    server.abort();
}

#[tokio::test]
async fn ready_callbacks_observe_cancellation_and_replay_state_is_bounded() {
    let cancellation = Cancellation::default();
    let sandbox = Arc::new(FakeSandbox::with_outputs([
        call(0, "teams.list"),
        "__FORGE_OUTPUT__{\"result\":42}".into(),
    ]));
    let capabilities = FakeCapabilities {
        cancel: Some(cancellation.clone()),
        ..FakeCapabilities::default()
    };
    assert_eq!(
        execution::execute_program(
            sandbox.clone(),
            &capabilities,
            &channel(),
            program(),
            Features::default(),
            &cancellation
        )
        .await
        .unwrap_err(),
        Error("Sandbox execution cancelled.")
    );
    assert_eq!(sandbox.commands.lock().unwrap().len(), 1);
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
    let sandbox = Arc::new(FakeSandbox::with_outputs([call(0, "teams.list")]));
    let capabilities = FakeCapabilities {
        responses: Mutex::new(VecDeque::from([json!("x".repeat(4 * 1024 * 1024))])),
        ..FakeCapabilities::default()
    };
    assert_eq!(
        execution::execute_program(
            sandbox.clone(),
            &capabilities,
            &channel(),
            program(),
            Features::default(),
            &Cancellation::default()
        )
        .await
        .unwrap_err(),
        Error("Program replay state exceeds the size limit.")
    );
    assert_eq!(sandbox.removed.lock().unwrap().len(), 1);
}
