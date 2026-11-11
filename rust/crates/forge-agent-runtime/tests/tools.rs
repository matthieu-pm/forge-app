use async_trait::async_trait;
use forge_agent_runtime::{
    Error, Result,
    auth::Channel,
    callback::{Capabilities, Request},
    execution::Features,
    sandbox::{Cancellation, Execution, Sandbox},
    tools::{Approval, Executor, Outcome},
};
use forge_core::agents::{approval, tools};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

const RUN: &str = "00000000-0000-4000-8000-000000000001";
fn channel() -> Channel {
    let data: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let value = &data["runtimeService"]["auth"][0];
    Channel::verify(
        value["secret"].as_str().unwrap(),
        value["authorization"].as_str().unwrap(),
        value["now"].as_i64().unwrap(),
    )
    .unwrap()
}
fn team() -> Value {
    json!({"id":RUN,"slug":"forge","identifier":"FOR","name":"Forge","timezone":"Europe/Paris","description":"Test team","privateExtra":"never serialize this"})
}
fn artifact() -> Value {
    json!({"id":RUN,"runId":RUN,"kind":"file","name":"result.txt","contentType":"text/plain","sizeBytes":5,"checksum":"a".repeat(64),"retentionExpiresAt":null,"deletedAt":null,"createdAt":"2026-11-01T00:00:00.000Z"})
}
#[derive(Default)]
struct Calls {
    requests: Mutex<Vec<Value>>,
    malformed: bool,
    pending: bool,
    dropped: Arc<AtomicUsize>,
}
struct InFlight(Arc<AtomicUsize>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Capabilities for Calls {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value> {
        assert_eq!(channel.run_id(), RUN);
        self.requests.lock().unwrap().push(json!({"id":request.id,"version":request.version,"input":request.input,"idempotencyKey":request.idempotency_key}));
        let _in_flight = InFlight(self.dropped.clone());
        if self.pending {
            std::future::pending::<()>().await;
        }
        if self.malformed {
            return Ok(json!({"token":"sk-private-response"}));
        }
        Ok(match request.id.as_str() {
            "teams.list" => json!({"items":[team()],"nextCursor":null,"extra":"private"}),
            "teams.get" | "teams.update" => team(),
            "workspace.describe" => {
                json!({"id":"workspace","name":"Forge","slug":"forge","actorRole":"owner","extra":"private"})
            }
            "artifacts.create" => artifact(),
            _ => return Err(Error("Unexpected fixture capability.")),
        })
    }
}
#[derive(Default)]
struct FakeSandbox {
    writes: AtomicUsize,
    runs: AtomicUsize,
    removals: AtomicUsize,
}
#[async_trait]
impl Sandbox for FakeSandbox {
    async fn write(&self, _: &str, _: &str) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok(Execution {
            exit_code: 0,
            stderr: String::new(),
            stdout: if command.contains("runner.mjs") {
                "__FORGE_OUTPUT__{\"result\":42}\n".into()
            } else {
                "42\n".into()
            },
        })
    }
    async fn remove(&self, _: &str) -> Result<()> {
        self.removals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
fn make_executor(calls: Arc<Calls>) -> Executor {
    Executor {
        capabilities: calls,
        sandbox: None,
        features: Features::default(),
    }
}
fn resolved(prepared: &forge_agent_runtime::tools::Prepared, approved: bool) -> Approval {
    Approval::Resolved {
        run_id: RUN.into(),
        tool_name: prepared.name().into(),
        input_hash: prepared.input_hash().into(),
        approved,
    }
}
fn update() -> Value {
    json!({"slug":" Forge ","settings":{"name":" Renamed ","description":" Updated "}})
}
fn program() -> Value {
    json!({"language":"javascript","code":"return 42","capabilityManifest":[{"id":"teams.update","version":"1","maximumCalls":1}]})
}
#[test]
fn authored_tool_inputs_descriptions_and_approval_hashes_match_source() {
    let data: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let executor = make_executor(Arc::new(Calls::default()));
    assert_eq!(tools::descriptors().len(), 7);
    for fixture in data["runtimeTools"].as_array().unwrap() {
        let name = fixture["name"].as_str().unwrap();
        let result = executor.prepare(name, fixture["input"].clone());
        assert_eq!(
            result.is_ok(),
            fixture["valid"].as_bool().unwrap(),
            "{fixture}"
        );
        if let Ok(prepared) = result {
            assert_eq!(prepared.input(), &fixture["result"]);
            assert_eq!(prepared.input_hash(), fixture["inputHash"]);
            assert_eq!(
                prepared.requires_approval(),
                fixture["approval"].as_bool().unwrap()
            );
        }
        let descriptor = tools::descriptors()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap();
        assert!(descriptor["inputSchema"].is_object());
        assert!(!descriptor["description"].as_str().unwrap().is_empty());
    }
    assert!(executor.prepare("read_environment", json!({})).is_err());
}
#[tokio::test]
async fn authored_reads_artifacts_and_approved_writes_use_bound_gateway_callbacks() {
    let calls = Arc::new(Calls::default());
    let executor = make_executor(calls.clone());
    let channel = channel();
    let cancellation = Cancellation::default();
    for (name, input, id) in [
        ("list_teams", json!({}), "teams.list"),
        ("get_team", json!({"slug":"forge"}), "teams.get"),
        ("describe_workspace", json!({}), "workspace.describe"),
        (
            "create_artifact",
            json!({"name":"result.txt","contentType":"text/plain","content":"hello"}),
            "artifacts.create",
        ),
        ("update_team", update(), "teams.update"),
    ] {
        let prepared = executor.prepare(name, input).unwrap();
        let hash = prepared.input_hash().to_owned();
        let decision = if prepared.requires_approval() {
            resolved(&prepared, true)
        } else {
            Approval::Pending
        };
        let Outcome::Completed(result) = executor
            .execute(&channel, prepared, decision, &cancellation)
            .await
            .unwrap()
        else {
            panic!("tool did not complete")
        };
        assert!(!result.to_string().contains("private"));
        let requests = calls.requests.lock().unwrap();
        let request = requests.last().unwrap();
        assert_eq!(request["id"], id);
        assert_eq!(request["version"], "1");
        if name == "update_team" {
            assert_eq!(
                request["idempotencyKey"],
                format!("eve:{RUN}:teams.update:{hash}")
            );
            assert_eq!(request["input"]["settings"]["name"], "Renamed");
        } else {
            assert!(request["idempotencyKey"].is_null());
        }
    }
    assert_eq!(calls.requests.lock().unwrap().len(), 5);
    let malformed = make_executor(Arc::new(Calls {
        malformed: true,
        ..Calls::default()
    }));
    let result = malformed
        .execute(
            &channel,
            malformed.prepare("list_teams", json!({})).unwrap(),
            Approval::Pending,
            &cancellation,
        )
        .await;
    assert!(matches!(
        result,
        Err(Error("Forge returned an invalid tool response."))
    ));
}
#[tokio::test]
async fn pending_denied_or_mismatched_approval_has_no_callback_or_sandbox_effects() {
    let calls = Arc::new(Calls::default());
    let sandbox = Arc::new(FakeSandbox::default());
    let mut executor = make_executor(calls.clone());
    executor.sandbox = Some(sandbox.clone());
    let channel = channel();
    let cancellation = Cancellation::default();
    for (name, input) in [("update_team", update()), ("execute_program", program())] {
        let prepared = executor.prepare(name, input.clone()).unwrap();
        assert!(matches!(
            executor
                .execute(&channel, prepared, Approval::Pending, &cancellation)
                .await
                .unwrap(),
            Outcome::ApprovalRequired(_)
        ));
        for field in ["run", "name", "hash"] {
            let prepared = executor.prepare(name, input.clone()).unwrap();
            let decision = Approval::Resolved {
                run_id: if field == "run" { "wrong" } else { RUN }.into(),
                tool_name: if field == "name" { "wrong" } else { name }.into(),
                input_hash: if field == "hash" {
                    "wrong".into()
                } else {
                    prepared.input_hash().into()
                },
                approved: true,
            };
            assert!(matches!(
                executor
                    .execute(&channel, prepared, decision, &cancellation)
                    .await,
                Err(Error("Tool approval binding mismatch."))
            ));
        }
        let prepared = executor.prepare(name, input).unwrap();
        let decision = resolved(&prepared, false);
        assert!(matches!(
            executor
                .execute(&channel, prepared, decision, &cancellation)
                .await
                .unwrap(),
            Outcome::Denied
        ));
    }
    assert!(calls.requests.lock().unwrap().is_empty());
    assert_eq!(sandbox.writes.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn code_uses_only_injected_sandbox_and_dispatch_rechecks_disabled_features() {
    let calls = Arc::new(Calls::default());
    let sandbox = Arc::new(FakeSandbox::default());
    let mut executor = make_executor(calls.clone());
    let channel = channel();
    let cancel = Cancellation::default();
    let code = json!({"language":"javascript","code":"console.log(42)"});
    assert!(matches!(
        executor
            .execute(
                &channel,
                executor.prepare("run_code", code.clone()).unwrap(),
                Approval::Pending,
                &cancel
            )
            .await,
        Err(Error("The isolated sandbox is unavailable."))
    ));
    executor.sandbox = Some(sandbox.clone());
    assert!(matches!(
        executor
            .execute(
                &channel,
                executor.prepare("run_code", code).unwrap(),
                Approval::Pending,
                &cancel
            )
            .await
            .unwrap(),
        Outcome::Completed(_)
    ));
    let prepared = executor.prepare("execute_program", program()).unwrap();
    let decision = resolved(&prepared, true);
    let Outcome::Completed(result) = executor
        .execute(&channel, prepared, decision, &cancel)
        .await
        .unwrap()
    else {
        panic!("program did not complete")
    };
    assert_eq!(result["result"], 42);
    assert_eq!(sandbox.runs.load(Ordering::SeqCst), 2);
    assert_eq!(sandbox.removals.load(Ordering::SeqCst), 2);
    assert!(calls.requests.lock().unwrap().is_empty());
    let prepared = executor.prepare("update_team", update()).unwrap();
    let decision = resolved(&prepared, true);
    executor.features.write_tools = false;
    assert!(matches!(
        executor
            .execute(&channel, prepared, decision, &cancel)
            .await,
        Err(Error("Agent write tools are disabled."))
    ));
    assert!(executor.prepare("execute_program", program()).is_err());
}
#[tokio::test]
async fn cancelling_a_callback_drops_its_pending_transport() {
    let calls = Arc::new(Calls {
        pending: true,
        ..Calls::default()
    });
    let executor = make_executor(calls.clone());
    let cancellation = Cancellation::default();
    let cancel = cancellation.clone();
    let task = tokio::spawn(async move {
        let channel = channel();
        executor
            .execute(
                &channel,
                executor.prepare("list_teams", json!({})).unwrap(),
                Approval::Pending,
                &cancel,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while calls.requests.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    assert!(matches!(
        task.await.unwrap(),
        Err(Error("Tool execution cancelled."))
    ));
    assert_eq!(calls.dropped.load(Ordering::SeqCst), 1);
}
#[test]
fn callback_outputs_strip_private_extra_fields_and_enforce_required_public_shape() {
    assert_eq!(tools::output("get_team", Value::Null).unwrap(), Value::Null);
    let mut value = team();
    value.as_object_mut().unwrap().remove("description");
    assert!(tools::output("get_team", value).is_err());
    let mut value = artifact();
    value["providerCredential"] = json!("private");
    assert_eq!(tools::output("create_artifact", value).unwrap(), artifact());
    let mut value = artifact();
    value["checksum"] = json!("invalid");
    assert!(tools::output("create_artifact", value).is_err());
    let prepared = tools::input("update_team", update()).unwrap();
    assert_eq!(
        approval::input_hash(&prepared),
        approval::input_hash(
            &tools::input(
                "update_team",
                json!({"settings":{"description":"Updated","name":"Renamed"},"slug":"forge"})
            )
            .unwrap()
        )
    );
}
