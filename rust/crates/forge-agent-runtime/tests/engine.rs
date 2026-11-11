use async_trait::async_trait;
use forge_agent_runtime::{
    Error, Result,
    auth::Channel,
    callback::{Capabilities, Request},
    engine::{Decision, Engine, Journal, Phase, State},
    execution::Features,
    model::{
        stream::{Completion, Delta, Finish},
        transport::{Model, Sink, Turn},
    },
    sandbox::{Cancellation, Execution, Sandbox},
    tools::Executor,
};
use forge_core::agents::{
    eve,
    tokens::{Kind, mint},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};
const RUN: &str = "00000000-0000-4000-8000-000000000001";
fn make_channel(user: &str) -> Channel {
    let secret = "public-engine-fixture-signing-secret";
    let token=mint(secret,Kind::RuntimeChannel,json!({"sub":user,"workspaceId":"workspace","runId":RUN,"forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-access-token","provider":"openai","modelId":"bound-model","reasoningEffort":"medium"}),1000,900.).unwrap();
    Channel::verify(secret, &format!("Bearer {token}"), 1001).unwrap()
}
fn initial(channel: &Channel) -> State {
    State::new(
        channel,
        vec![json!({"role":"user","content":[{"type":"text","text":"Help with Forge."}]})],
    )
    .unwrap()
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
struct Memory {
    state: Mutex<State>,
    events: Mutex<Vec<Value>>,
    commits: AtomicUsize,
    fail_before: AtomicUsize,
    fail_after: AtomicUsize,
    fail_append: bool,
}
impl Memory {
    fn new(state: State) -> Self {
        Self {
            state: Mutex::new(state),
            events: Mutex::new(vec![]),
            commits: AtomicUsize::new(0),
            fail_before: AtomicUsize::new(0),
            fail_after: AtomicUsize::new(0),
            fail_append: false,
        }
    }
    fn load(&self, channel: &Channel) -> State {
        State::restore(self.state.lock().unwrap().snapshot(), channel).unwrap()
    }
    fn normalized(&self) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .flat_map(|(i, v)| {
                eve::normalize(v.clone(), "session_fixture", Some(i as f64)).unwrap()
            })
            .collect()
    }
}
#[async_trait]
impl Journal for Memory {
    async fn commit(&self, expected: u64, next: &State, events: &[Value]) -> Result<()> {
        let n = self.commits.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_before.load(Ordering::SeqCst) == n {
            return Err(Error("Fixture persistence unavailable."));
        }
        let mut stored = self.state.lock().unwrap();
        if stored.revision() != expected || next.revision() != expected + 1 {
            return Err(Error("Stale journal owner."));
        }
        *stored = next.clone();
        self.events.lock().unwrap().extend_from_slice(events);
        if self.fail_after.load(Ordering::SeqCst) == n {
            return Err(Error("Fixture commit acknowledgement lost."));
        }
        Ok(())
    }
    async fn append(&self, revision: u64, event: Value) -> Result<()> {
        if self.fail_append {
            return Err(Error("Fixture stream persistence unavailable."));
        }
        if self.state.lock().unwrap().revision() != revision {
            return Err(Error("Stale stream owner."));
        }
        self.events.lock().unwrap().push(event);
        Ok(())
    }
}
struct Scripted {
    steps: Vec<Vec<Value>>,
    calls: AtomicUsize,
    prompts: Mutex<Vec<Vec<Value>>>,
    pending: bool,
    entered: Notify,
    usage: u64,
    tools: usize,
}
impl Scripted {
    fn new(steps: Vec<Vec<Value>>) -> Self {
        Self {
            steps,
            calls: AtomicUsize::new(0),
            prompts: Mutex::new(vec![]),
            pending: false,
            entered: Notify::new(),
            usage: 10,
            tools: 7,
        }
    }
}
#[async_trait]
impl Model for Scripted {
    async fn generate(
        &self,
        _: &Channel,
        turn: Turn<'_>,
        _: &Cancellation,
        sink: &mut dyn Sink,
    ) -> Result<Completion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.prompts.lock().unwrap().push(turn.prompt.to_vec());
        assert_eq!(turn.tools.len(), self.tools);
        assert!(turn.max_output_tokens.unwrap() > 0);
        if self.pending {
            std::future::pending::<()>().await;
        }
        let step = turn
            .prompt
            .iter()
            .filter(|v| v["role"] == "assistant")
            .count();
        let content = self
            .steps
            .get(step)
            .cloned()
            .unwrap_or_else(|| vec![json!({"type":"text","text":"Finished."})]);
        for p in &content {
            if p["type"] == "text" {
                sink.emit(Delta::Text {
                    id: "message".into(),
                    text: p["text"].as_str().unwrap().into(),
                })
                .await?;
            }
        }
        let finish = if content.iter().any(|v| v["type"] == "tool-call") {
            Finish::ToolCalls
        } else {
            Finish::Stop
        };
        Ok(Completion {
            content,
            finish,
            usage: json!({"inputTokens":self.usage,"outputTokens":5,"cacheReadTokens":null,"cacheWriteTokens":null,"reasoningTokens":null}),
        })
    }
}
struct Calls {
    journal: Arc<Memory>,
    requests: Mutex<Vec<Value>>,
}
#[async_trait]
impl Capabilities for Calls {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value> {
        let stored = self.journal.state.lock().unwrap().snapshot();
        let next = stored["next_call"].as_u64().unwrap() as usize;
        assert_eq!(
            stored["calls"][next]["phase"], "calling",
            "effects require a persisted dispatch reservation"
        );
        assert_eq!(channel.run_id(), RUN);
        self.requests
            .lock()
            .unwrap()
            .push(json!({"id":request.id,"key":request.idempotency_key,"input":request.input}));
        let team = json!({"id":RUN,"slug":"forge","identifier":"FOR","name":"Forge","timezone":"Europe/Paris","description":"Fixture"});
        Ok(match request.id.as_str() {
            "teams.list" => json!({"items":[team],"nextCursor":null}),
            "teams.get" | "teams.update" => team,
            "workspace.describe" => {
                json!({"id":"workspace","name":"Forge","slug":"forge","actorRole":"owner"})
            }
            "artifacts.create" => {
                json!({"id":RUN,"runId":RUN,"kind":"file","name":"result.txt","contentType":"text/plain","sizeBytes":1,"checksum":"a".repeat(64),"retentionExpiresAt":null,"deletedAt":null,"createdAt":"2026-11-01T00:00:00.000Z"})
            }
            _ => return Err(Error("Unexpected fixture capability.")),
        })
    }
}
#[derive(Default)]
struct FakeSandbox {
    runs: AtomicUsize,
}
#[async_trait]
impl Sandbox for FakeSandbox {
    async fn write(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok(Execution {
            exit_code: 0,
            stdout: if command.contains("runner.mjs") {
                "__FORGE_OUTPUT__{\"result\":42}\n".into()
            } else {
                "42\n".into()
            },
            stderr: String::new(),
        })
    }
    async fn remove(&self, _: &str) -> Result<()> {
        Ok(())
    }
}
fn call(name: &str, input: Value) -> Value {
    json!({"type":"tool-call","toolCallId":format!("call_{name}"),"toolName":name,"input":input})
}
fn setup(
    model: Arc<Scripted>,
    journal: Arc<Memory>,
    sandbox: Option<Arc<FakeSandbox>>,
) -> (Engine, Arc<Calls>) {
    let calls = Arc::new(Calls {
        journal,
        requests: Mutex::new(vec![]),
    });
    let executor = Arc::new(Executor {
        capabilities: calls.clone(),
        sandbox: sandbox.map(|s| s as Arc<dyn Sandbox>),
        features: Features::default(),
    });
    (Engine::new(model, executor), calls)
}
#[tokio::test]
async fn model_tool_model_turn_persists_history_results_usage_and_public_events() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![call("list_teams", json!({}))]]));
    let (engine, calls) = setup(model.clone(), journal.clone(), None);
    assert_eq!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .unwrap(),
        Phase::Complete
    );
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    assert_eq!(state.usage(), (20, 10));
    let history = state.history();
    assert_eq!(history[2]["content"][0]["input"]["limit"], 50);
    assert_eq!(
        history[3]["content"][0]["output"]["value"]["items"][0]["name"],
        "Forge"
    );
    assert_eq!(history.last().unwrap()["content"][0]["text"], "Finished.");
    let normalized = journal.normalized();
    for kind in [
        "run.usage",
        "tool.started",
        "tool.completed",
        "assistant.delta",
        "assistant.message",
    ] {
        assert!(normalized.iter().any(|e| e["type"] == kind), "{kind}");
    }
    let snapshot = serde_json::to_string(&state.snapshot()).unwrap();
    assert!(!snapshot.contains("fixture-capability-token"));
    assert!(!snapshot.contains("model-access-token"));
    let mut restored = journal.load(&channel);
    let before = journal.events.lock().unwrap().len();
    engine
        .drive(
            &channel,
            &mut restored,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(journal.events.lock().unwrap().len(), before);
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn approvals_survive_restore_bind_normalized_input_and_denials_continue_the_conversation() {
    for decision in [Decision::Approved, Decision::Denied] {
        let channel = make_channel("user");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![vec![call(
            "update_team",
            json!({"slug":" Forge ","settings":{"name":" Renamed "}}),
        )]]));
        let (engine, calls) = setup(model.clone(), journal.clone(), None);
        assert_eq!(
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .unwrap(),
            Phase::Waiting
        );
        assert!(calls.requests.lock().unwrap().is_empty());
        let request = state.pending_request().unwrap().to_owned();
        let normalized = journal.normalized();
        let approval = normalized
            .iter()
            .find(|e| e["type"] == "approval.requested")
            .unwrap();
        assert_eq!(approval["payload"]["input"]["slug"], "forge");
        assert_eq!(approval["payload"]["details"]["runtimeRequestId"], request);
        let mut restored = journal.load(&channel);
        assert!(
            engine
                .resume(&channel, &mut restored, journal.as_ref(), "stale", decision)
                .await
                .is_err()
        );
        assert!(
            engine
                .resume(
                    &make_channel("another"),
                    &mut restored,
                    journal.as_ref(),
                    &request,
                    decision
                )
                .await
                .is_err()
        );
        journal
            .fail_after
            .store(journal.commits.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
        assert!(
            engine
                .resume(
                    &channel,
                    &mut restored,
                    journal.as_ref(),
                    &request,
                    decision
                )
                .await
                .is_err()
        );
        assert!(calls.requests.lock().unwrap().is_empty());
        restored = journal.load(&channel);
        assert_eq!(restored.decision(&request), Some(decision));
        engine
            .resume(
                &channel,
                &mut restored,
                journal.as_ref(),
                &request,
                decision,
            )
            .await
            .unwrap();
        assert_eq!(
            engine
                .drive(
                    &channel,
                    &mut restored,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .unwrap(),
            Phase::Complete
        );
        let requests = calls.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), usize::from(decision == Decision::Approved));
        if decision == Decision::Approved {
            assert!(
                requests[0]["key"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("eve:{RUN}:teams.update:"))
            );
        } else {
            assert_eq!(
                restored.history()[3]["content"][0]["output"]["type"],
                "execution-denied"
            );
        }
        let settled_revision = restored.revision();
        engine
            .resume(
                &channel,
                &mut restored,
                journal.as_ref(),
                &request,
                decision,
            )
            .await
            .unwrap();
        assert_eq!(restored.revision(), settled_revision);
        assert_eq!(restored.decision(&request), Some(decision));
        let opposite = if decision == Decision::Approved {
            Decision::Denied
        } else {
            Decision::Approved
        };
        assert!(
            engine
                .resume(
                    &channel,
                    &mut restored,
                    journal.as_ref(),
                    &request,
                    opposite
                )
                .await
                .is_err()
        );
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    }
}
#[tokio::test]
async fn unknown_and_invalid_tools_become_model_visible_errors_without_effects() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![
        call("delete_workspace", json!({})),
        call("update_team", json!({"slug":"forge","settings":{}})),
    ]]));
    let (engine, calls) = setup(model, journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert!(calls.requests.lock().unwrap().is_empty());
    assert_eq!(state.history()[3]["content"].as_array().unwrap().len(), 2);
    assert!(
        state.history()[3]["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["output"]["type"] == "error-text")
    );
}
#[tokio::test]
async fn failed_model_checkpoint_prevents_tools_and_restarts_from_saved_history() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    journal.fail_before.store(2, Ordering::SeqCst);
    let model = Arc::new(Scripted::new(vec![vec![call("list_teams", json!({}))]]));
    let (engine, calls) = setup(model.clone(), journal.clone(), None);
    assert!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .is_err()
    );
    assert!(calls.requests.lock().unwrap().is_empty());
    assert_eq!(journal.load(&channel).phase(), Phase::Generating);
    let mut restored = journal.load(&channel);
    engine
        .drive(
            &channel,
            &mut restored,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    assert_eq!(model.calls.load(Ordering::SeqCst), 3);
}
#[tokio::test]
async fn ambiguous_receipt_acknowledgement_reuses_the_committed_result() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    journal.fail_after.store(4, Ordering::SeqCst);
    let model = Arc::new(Scripted::new(vec![vec![call(
        "create_artifact",
        json!({"name":"result.txt","contentType":"text/plain","content":"x"}),
    )]]));
    let (engine, calls) = setup(model, journal.clone(), None);
    assert!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .is_err()
    );
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    let mut restored = journal.load(&channel);
    engine
        .drive(
            &channel,
            &mut restored,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn interrupted_unreceipted_artifact_is_not_automatically_reexecuted() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    journal.fail_before.store(4, Ordering::SeqCst);
    let model = Arc::new(Scripted::new(vec![vec![call(
        "create_artifact",
        json!({"name":"result.txt","contentType":"text/plain","content":"x"}),
    )]]));
    let (engine, calls) = setup(model, journal.clone(), None);
    assert!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .is_err()
    );
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    let mut restored = journal.load(&channel);
    let error = engine
        .drive(
            &channel,
            &mut restored,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("reconciliation"));
    assert_eq!(restored.phase(), Phase::Failed);
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn stale_worker_cannot_start_a_model_and_corrupted_input_hash_cannot_resume() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let stale = state.clone();
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![call(
        "update_team",
        json!({"slug":"forge","settings":{"name":"Changed"}}),
    )]]));
    let (engine, calls) = setup(model.clone(), journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    let mut stale = stale;
    assert!(
        engine
            .drive(
                &channel,
                &mut stale,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .is_err()
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let mut snapshot = state.snapshot();
    snapshot["calls"][0]["input"]["settings"]["name"] = json!("Different");
    assert!(State::restore(snapshot, &channel).is_err());
    assert!(calls.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn code_and_write_programs_share_the_checkpointed_tool_path() {
    for name in ["run_code", "execute_program"] {
        let input = if name == "run_code" {
            json!({"language":"javascript","code":"console.log(42)"})
        } else {
            json!({"language":"javascript","code":"return 42","capabilityManifest":[{"id":"teams.update","version":"1","maximumCalls":1}]})
        };
        let channel = make_channel("user");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![vec![call(name, input)]]));
        let sandbox = Arc::new(FakeSandbox::default());
        let (engine, _) = setup(model, journal.clone(), Some(sandbox.clone()));
        let phase = engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline(),
            )
            .await
            .unwrap();
        if name == "execute_program" {
            assert_eq!(phase, Phase::Waiting);
            assert_eq!(sandbox.runs.load(Ordering::SeqCst), 0);
            let request = state.pending_request().unwrap().to_owned();
            engine
                .resume(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &request,
                    Decision::Approved,
                )
                .await
                .unwrap();
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline(),
                )
                .await
                .unwrap();
        }
        assert_eq!(state.phase(), Phase::Complete);
        assert_eq!(sandbox.runs.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn token_limits_stop_the_next_model_step_and_large_deltas_preserve_unicode() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![call(
        "describe_workspace",
        json!({}),
    )]]));
    let (mut engine, calls) = setup(model.clone(), journal.clone(), None);
    engine.max_input_tokens = 10;
    assert!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .is_err()
    );
    assert_eq!(state.phase(), Phase::Failed);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    let message = "😀hé".repeat(5000);
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![
        json!({"type":"text","text":message}),
    ]]));
    let (engine, _) = setup(model, journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    let events = journal.normalized();
    let parts: Vec<_> = events
        .iter()
        .filter(|v| v["type"] == "assistant.delta")
        .map(|v| v["payload"]["delta"].as_str().unwrap())
        .collect();
    assert!(parts.len() > 1);
    assert_eq!(parts.concat(), message);
}
#[tokio::test]
async fn cancellation_deadline_and_stream_persistence_failure_stop_before_tools() {
    let channel = make_channel("user");
    let state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted {
        pending: true,
        ..Scripted::new(vec![])
    });
    let (engine, calls) = setup(model.clone(), journal.clone(), None);
    let cancel = Cancellation::default();
    let task_cancel = cancel.clone();
    let task_journal = journal.clone();
    let task_channel = channel.clone();
    let task = tokio::spawn(async move {
        let mut state = state;
        engine
            .drive(
                &task_channel,
                &mut state,
                task_journal.as_ref(),
                &task_cancel,
                deadline(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), model.entered.notified())
        .await
        .unwrap();
    cancel.cancel();
    assert!(task.await.unwrap().is_err());
    assert!(calls.requests.lock().unwrap().is_empty());
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let (engine, calls) = setup(model, journal.clone(), None);
    let error = engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            Instant::now() + Duration::from_millis(50),
        )
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("timed out"));
    assert!(calls.requests.lock().unwrap().is_empty());
    let mut state = initial(&channel);
    let journal = Arc::new(Memory {
        fail_append: true,
        ..Memory::new(state.clone())
    });
    let model = Arc::new(Scripted::new(vec![vec![
        json!({"type":"text","text":"Checking"}),
        call("list_teams", json!({})),
    ]]));
    let (engine, calls) = setup(model, journal.clone(), None);
    assert!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .is_err()
    );
    assert!(calls.requests.lock().unwrap().is_empty());
}

#[path = "acceptance/framework_engine.rs"]
mod framework_engine;
