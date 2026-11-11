use async_trait::async_trait;
use forge_agent_runtime::{
    Error, Result,
    framework::{Executor, FileState},
    sandbox::{Cancellation, Execution, FILE_LIMIT, Sandbox, Workspace},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
fn reference() -> Value {
    serde_json::from_str(include_str!("../data/framework-reference.json")).unwrap()
}
struct Fake {
    id: String,
    files: Mutex<BTreeMap<String, String>>,
    commands: Mutex<Vec<String>>,
    rg: bool,
    probe_failures: AtomicUsize,
    home: Option<String>,
    output: Value,
    pending: bool,
    write_failure: bool,
    dropped: Arc<AtomicUsize>,
}
impl Fake {
    fn new(value: &Value) -> Self {
        Self {
            id: "fixture".into(),
            files: Mutex::new(serde_json::from_value(value["files"].clone()).unwrap_or_default()),
            commands: Mutex::new(vec![]),
            rg: value["rg"] != false,
            probe_failures: AtomicUsize::new(value["probeFailures"].as_u64().unwrap_or(0) as usize),
            home: match value.get("home") {
                Some(Value::Null) => None,
                Some(v) => Some(v.as_str().unwrap().into()),
                None => Some("/home/user".into()),
            },
            output: value["output"].clone(),
            pending: false,
            write_failure: false,
            dropped: Arc::new(AtomicUsize::new(0)),
        }
    }
}
struct DropCount(Arc<AtomicUsize>);
impl Drop for DropCount {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Sandbox for Fake {
    async fn write(&self, _: &str, _: &str) -> Result<()> {
        panic!("Relative code files are not framework file writes")
    }
    async fn remove(&self, _: &str) -> Result<()> {
        panic!("Framework files must survive tool calls")
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        self.commands.lock().unwrap().push(command.into());
        let _guard = DropCount(self.dropped.clone());
        if self.pending {
            std::future::pending::<()>().await;
        }
        if command == "printf '%s\\n' \"$HOME\"" {
            return Ok(Execution {
                stdout: self
                    .home
                    .as_ref()
                    .map(|v| format!("{v}\n"))
                    .unwrap_or_default(),
                stderr: "".into(),
                exit_code: if self.home.is_some() { 0 } else { 1 },
            });
        }
        if command.starts_with("command -v rg") {
            if self
                .probe_failures
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err(Error("Temporary sandbox transport error."));
            }
            return Ok(Execution {
                stdout: "".into(),
                stderr: "".into(),
                exit_code: if self.rg { 1 } else { 127 },
            });
        }
        Ok(Execution {
            stdout: self.output["stdout"].as_str().unwrap_or("").into(),
            stderr: self.output["stderr"].as_str().unwrap_or("").into(),
            exit_code: self.output["exitCode"].as_i64().unwrap_or(0) as i32,
        })
    }
}
#[async_trait]
impl Workspace for Fake {
    fn identity(&self) -> &str {
        &self.id
    }
    async fn read_text(&self, path: &str) -> Result<Option<String>> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }
    async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        if self.write_failure {
            return Err(Error("Fixture write failed."));
        }
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), content.into());
        Ok(())
    }
}
#[test]
fn inputs_match_installed_framework_schemas() {
    for case in reference()["validation"].as_array().unwrap() {
        let actual = forge_core::agents::framework::input(
            case["name"].as_str().unwrap(),
            case["input"].clone(),
        );
        assert_eq!(actual.is_ok(), case["valid"] == true, "{case}");
        if let Ok(actual) = actual {
            assert_eq!(actual, case["result"], "{case}");
        }
    }
    assert_eq!(forge_core::agents::framework::descriptors().len(), 5);
}
#[tokio::test]
async fn sandbox_tools_match_source_scenarios_and_commands() {
    for (index, scenario) in reference()["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let fake = Arc::new(Fake::new(scenario));
        let executor = Executor::new(fake.clone());
        let mut state = FileState::default();
        for (step_index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let name = step["name"].as_str().unwrap();
            let input = step["input"].clone();
            let actual = match name {
                "mutate" => {
                    fake.files.lock().unwrap().insert(
                        input["path"].as_str().unwrap().into(),
                        input["content"].as_str().unwrap().into(),
                    );
                    Ok(Value::Null)
                }
                "clear" => {
                    state.clear();
                    Ok(Value::Null)
                }
                _ => {
                    executor
                        .execute(name, input, &mut state, &Cancellation::default())
                        .await
                }
            };
            assert_eq!(
                actual.is_err(),
                step["error"] == true,
                "scenario {index} step {step_index}: {actual:?}"
            );
            if let Ok(actual) = actual {
                assert_eq!(actual, step["result"], "scenario {index} step {step_index}");
            }
            let commands: Vec<_> = fake.commands.lock().unwrap().drain(..).collect();
            assert_eq!(
                json!(commands),
                step["commands"],
                "scenario {index} step {step_index}"
            );
            // Stamps are serializable private continuation state, not process-only.
            state = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
        }
        assert_eq!(json!(*fake.files.lock().unwrap()), scenario["finalFiles"]);
    }
}
#[tokio::test]
async fn read_permission_cannot_cross_sandbox_replacement_or_context_reset() {
    let a = Arc::new(Fake::new(&json!({"files":{"/workspace/a":"old"}})));
    let first = Executor::new(a.clone());
    let mut state = FileState::default();
    first
        .execute(
            "read_file",
            json!({"filePath":"/workspace/a"}),
            &mut state,
            &Cancellation::default(),
        )
        .await
        .unwrap();
    let mut b = Fake::new(&json!({"files":{"/workspace/a":"old"}}));
    b.id = "replacement".into();
    let second = Executor::new(Arc::new(b));
    assert!(
        second
            .execute(
                "write_file",
                json!({"filePath":"/workspace/a","content":"new"}),
                &mut state,
                &Cancellation::default()
            )
            .await
            .is_err()
    );
    state.clear();
    assert!(
        first
            .execute(
                "write_file",
                json!({"filePath":"/workspace/a","content":"new"}),
                &mut state,
                &Cancellation::default()
            )
            .await
            .is_err()
    );
    assert_eq!(a.files.lock().unwrap()["/workspace/a"], "old");
}
#[tokio::test]
async fn malformed_or_failed_operations_do_not_grant_write_permission() {
    let mut fake = Fake::new(
        &json!({"files":{"/workspace/a":"old","/workspace/huge":"x".repeat(FILE_LIMIT+1)}}),
    );
    fake.write_failure = true;
    let fake = Arc::new(fake);
    let executor = Executor::new(fake.clone());
    let mut state = FileState::default();
    let original = serde_json::to_value(&state).unwrap();
    for (name, input) in [
        ("read_file", json!({"filePath":"/workspace/a","offset":20})),
        ("read_file", json!({"filePath":"/workspace/huge"})),
        ("read_file", json!({"filePath":"/workspace/a\u{0000}"})),
        (
            "write_file",
            json!({"filePath":"/workspace/new","content":"data"}),
        ),
        (
            "write_file",
            json!({"filePath":"/workspace/new","content":"x".repeat(FILE_LIMIT+1)}),
        ),
    ] {
        assert!(
            executor
                .execute(name, input, &mut state, &Cancellation::default())
                .await
                .is_err()
        );
        assert_eq!(serde_json::to_value(&state).unwrap(), original);
    }
    assert!(fake.commands.lock().unwrap().is_empty());
}
#[tokio::test]
async fn cancellation_drops_inflight_sandbox_execution_and_keeps_state() {
    let mut fake = Fake::new(&json!({}));
    fake.pending = true;
    let fake = Arc::new(fake);
    let executor = Executor::new(fake.clone());
    let stop = Cancellation::default();
    let mut state = FileState::default();
    let call = executor.execute("bash", json!({"command":"sleep 100"}), &mut state, &stop);
    tokio::pin!(call);
    tokio::select! {v=&mut call=>panic!("unexpected {v:?}"),()=tokio::time::sleep(std::time::Duration::from_millis(10))=>{}}
    stop.cancel();
    assert!(call.await.is_err());
    assert_eq!(fake.dropped.load(Ordering::SeqCst), 1);
    assert!(
        executor
            .execute(
                "bash",
                json!({"command":"never"}),
                &mut FileState::default(),
                &stop
            )
            .await
            .is_err()
    );
    assert_eq!(fake.commands.lock().unwrap().len(), 1);
}
