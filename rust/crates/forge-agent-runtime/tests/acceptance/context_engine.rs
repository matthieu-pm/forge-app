use super::*;
#[tokio::test]
async fn task_list_and_tool_receipt_survive_lost_commit_acknowledgements() {
    let todos = json!([{ "content":"Finish the rewrite","status":"in_progress","priority":"high"}]);
    for after in [false, true] {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        if after {
            journal.fail_after.store(3, Ordering::SeqCst);
        } else {
            journal.fail_before.store(3, Ordering::SeqCst);
        }
        let model = Arc::new(Scripted::new(vec![
            vec![call("todo", json!({"todos":todos}))],
            vec![call("todo", json!({}))],
        ]));
        let calls = Arc::new(Calls {
            journal: journal.clone(),
            requests: Mutex::new(vec![]),
        });
        let engine = Engine::new(
            model.clone(),
            Arc::new(Executor {
                capabilities: calls.clone(),
                sandbox: None,
                features: Features::default(),
            }),
        );
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
        let mut restored = journal.load(&channel);
        assert_eq!(
            restored.snapshot()["todos"],
            if after { todos.clone() } else { json!([]) }
        );
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
        assert_eq!(restored.snapshot()["todos"], todos);
        let results = journal
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "action.result")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(result["data"]["result"]["output"]["value"]["todos"], todos);
        }
        assert!(calls.requests.lock().unwrap().is_empty());
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            3,
            "a persisted model response must not be regenerated"
        );
    }
}
#[test]
fn legacy_context_defaults_and_invalid_task_lists_are_checked() {
    let channel = make_channel("owner");
    let state = initial(&channel);
    let mut legacy = state.snapshot();
    legacy.as_object_mut().unwrap().remove("todos");
    assert_eq!(
        State::restore(legacy, &channel).unwrap().snapshot()["todos"],
        json!([])
    );
    for invalid in [
        Value::Null,
        json!([{"content":"task","priority":"urgent","status":"pending"}]),
        json!([{"content":"task","priority":"high","status":"pending","extra":true}]),
    ] {
        let mut snapshot = state.snapshot();
        snapshot["todos"] = invalid;
        assert!(State::restore(snapshot, &channel).is_err());
    }
}

use forge_agent_runtime::{context, model::transport::Purpose};
#[derive(Clone, Copy)]
enum SummaryMode {
    Good,
    Failure,
    Tool,
    Length,
    Empty,
    Pending,
}
struct SummaryModel {
    journal: Arc<Memory>,
    summaries: AtomicUsize,
    responses: AtomicUsize,
    entered: Notify,
    dropped: Arc<AtomicUsize>,
    mode: SummaryMode,
    response_prompts: Mutex<Vec<Vec<Value>>>,
}
struct SummaryDrop(Arc<AtomicUsize>);
impl Drop for SummaryDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Model for SummaryModel {
    async fn generate(
        &self,
        channel: &Channel,
        turn: Turn<'_>,
        _: &Cancellation,
        sink: &mut dyn Sink,
    ) -> Result<Completion> {
        assert_eq!(channel.run_id(), RUN);
        assert!(turn.deadline > Instant::now());
        if turn.purpose == Purpose::Compaction {
            assert_eq!(
                self.journal.state.lock().unwrap().phase(),
                Phase::Compacting
            );
            assert!(turn.tools.is_empty());
            assert_eq!(turn.prompt[0]["content"], context::prompt::SYSTEM);
            self.summaries.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            let _drop = SummaryDrop(self.dropped.clone());
            sink.emit(Delta::Text {
                id: "private".into(),
                text: "Private checkpoint text.".into(),
            })
            .await?;
            match self.mode {
                SummaryMode::Pending => std::future::pending::<()>().await,
                SummaryMode::Failure => return Err(Error("Fixture summary failure.")),
                _ => {}
            }
            return Ok(Completion {
                content: match self.mode {
                    SummaryMode::Tool => vec![call(
                        "write_file",
                        json!({"filePath":"/workspace/a","content":"forbidden"}),
                    )],
                    SummaryMode::Empty => vec![],
                    _ => vec![
                        json!({"type":"text","text":"Saved summary: preserve /workspace/a and finish the task."}),
                    ],
                },
                finish: match self.mode {
                    SummaryMode::Tool => Finish::ToolCalls,
                    SummaryMode::Length => Finish::Length,
                    _ => Finish::Stop,
                },
                usage: json!({"inputTokens":100,"outputTokens":20}),
            });
        }
        self.responses.fetch_add(1, Ordering::SeqCst);
        self.response_prompts
            .lock()
            .unwrap()
            .push(turn.prompt.to_vec());
        assert_eq!(
            self.journal.state.lock().unwrap().phase(),
            Phase::Generating
        );
        assert_eq!(
            self.journal.state.lock().unwrap().snapshot()["files"]["stamps"],
            json!({}),
            "compaction must revoke old file reads before the next model call"
        );
        sink.emit(Delta::Text {
            id: "public".into(),
            text: "Continued.".into(),
        })
        .await?;
        Ok(Completion {
            content: vec![json!({"type":"text","text":"Continued."})],
            finish: Finish::Stop,
            usage: json!({"inputTokens":50,"outputTokens":10}),
        })
    }
}
fn context_initial(channel: &Channel, history: Vec<Value>) -> State {
    let state = State::new(channel, history).unwrap();
    let mut snapshot = state.snapshot();
    snapshot["todos"] =
        json!([{ "content":"Finish the task","status":"in_progress","priority":"high"}]);
    snapshot["workspace"]["provisioned"] = json!(true);
    snapshot["files"] = json!({"workspace":format!("native-workspace:{}",snapshot["workspace"]["key"].as_str().unwrap()),"stamps":{"/workspace/a":{"bytes":8,"hash":"a".repeat(64)}}});
    State::restore(snapshot, channel).unwrap()
}
fn long_history() -> Vec<Value> {
    vec![
        json!({"role":"user","content":[{"type":"text","text":"x".repeat(9000)}]}),
        json!({"role":"assistant","content":[{"type":"text","text":"y".repeat(9000)}]}),
        json!({"role":"user","content":[{"type":"text","text":"Continue the task."}]}),
    ]
}
fn compaction_engine(
    journal: Arc<Memory>,
    mode: SummaryMode,
    threshold: u64,
) -> (Engine, Arc<SummaryModel>) {
    let model = Arc::new(SummaryModel {
        journal: journal.clone(),
        summaries: AtomicUsize::new(0),
        responses: AtomicUsize::new(0),
        entered: Notify::new(),
        dropped: Arc::new(AtomicUsize::new(0)),
        mode,
        response_prompts: Mutex::new(vec![]),
    });
    let calls = Arc::new(Calls {
        journal,
        requests: Mutex::new(vec![]),
    });
    let mut engine = Engine::new(
        model.clone(),
        Arc::new(Executor {
            capabilities: calls,
            sandbox: None,
            features: Features::default(),
        }),
    );
    engine.compaction.threshold = threshold;
    (engine, model)
}
#[tokio::test]
async fn compaction_receipts_fence_summary_calls_and_survive_all_commit_boundaries() {
    for commit in 1..=3 {
        for after in [false, true] {
            let channel = make_channel("owner");
            let mut state = context_initial(&channel, long_history());
            let journal = Arc::new(Memory::new(state.clone()));
            if after {
                journal.fail_after.store(commit, Ordering::SeqCst);
            } else {
                journal.fail_before.store(commit, Ordering::SeqCst);
            }
            let (mut engine, model) = compaction_engine(journal.clone(), SummaryMode::Good, 800);
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
            let mut state = journal.load(&channel);
            if state.phase() == Phase::Compacting {
                engine.compaction.threshold = 20_000;
            }
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
            assert_eq!(
                model.summaries.load(Ordering::SeqCst),
                if commit == 3 && !after { 2 } else { 1 }
            );
            assert_eq!(model.responses.load(Ordering::SeqCst), 1);
            assert_eq!(
                state.usage(),
                (50, 10),
                "source compaction calls are separate from step usage"
            );
            assert_eq!(state.snapshot()["compaction"]["last_input_tokens"], 50);
            let prompts = model.response_prompts.lock().unwrap();
            assert_eq!(prompts[0][1]["content"][0]["text"], context::CHECKPOINT);
            assert!(prompts[0].iter().any(|m| {
                m["content"][0]["text"]
                    .as_str()
                    .is_some_and(|s| s.starts_with(forge_core::agents::context::PRESERVATION_LABEL))
            }));
            let events = journal.events.lock().unwrap();
            for kind in [
                "turn.started",
                "compaction.requested",
                "compaction.completed",
            ] {
                assert_eq!(
                    events.iter().filter(|e| e["type"] == kind).count(),
                    1,
                    "{kind}"
                );
            }
            assert!(
                !events
                    .iter()
                    .any(|e| e.to_string().contains("Private checkpoint"))
            );
            assert_eq!(state.snapshot()["todos"][0]["status"], "in_progress");
        }
    }
}
#[tokio::test]
async fn reducing_old_tool_output_avoids_summary_calls_but_still_revokes_read_permissions() {
    let channel = make_channel("owner");
    let mut history = vec![
        json!({"role":"user","content":"Task"}),
        json!({"role":"assistant","content":[call("read_file",json!({"filePath":"/workspace/a"}))]}),
        json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call_read_file","toolName":"read_file","output":{"type":"json","value":"x".repeat(60_000)}}]}),
    ];
    for n in 0..12 {
        history.push(
            json!({"role":if n%2==0 {"user"}else{"assistant"},"content":format!("Message {n}")}),
        );
    }
    let mut state = context_initial(&channel, history);
    let journal = Arc::new(Memory::new(state.clone()));
    let (engine, model) = compaction_engine(journal.clone(), SummaryMode::Failure, 4000);
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
    assert_eq!(model.summaries.load(Ordering::SeqCst), 0);
    assert_eq!(model.responses.load(Ordering::SeqCst), 1);
    assert!(
        state
            .history()
            .iter()
            .any(|m| m.to_string().contains("Truncated by eve"))
    );
}
#[tokio::test]
async fn unusable_summaries_never_replace_original_history_or_grant_file_permissions() {
    for mode in [
        SummaryMode::Failure,
        SummaryMode::Tool,
        SummaryMode::Length,
        SummaryMode::Empty,
    ] {
        let channel = make_channel("owner");
        let mut state = context_initial(&channel, long_history());
        let before = state.snapshot();
        let journal = Arc::new(Memory::new(state.clone()));
        let (engine, model) = compaction_engine(journal.clone(), mode, 800);
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
        let restored = journal.load(&channel);
        assert_eq!(restored.phase(), Phase::Failed);
        assert_eq!(restored.snapshot()["messages"], before["messages"]);
        assert_eq!(restored.snapshot()["files"], before["files"]);
        assert_eq!(model.responses.load(Ordering::SeqCst), 0);
        assert!(
            !journal
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "compaction.completed")
        );
    }
}
#[tokio::test]
async fn cancellation_and_original_deadline_drop_inflight_summary_without_settling_it() {
    for cancel in [false, true] {
        let channel = make_channel("owner");
        let mut state = context_initial(&channel, long_history());
        let journal = Arc::new(Memory::new(state.clone()));
        let (engine, model) = compaction_engine(journal.clone(), SummaryMode::Pending, 800);
        let cancellation = Cancellation::default();
        let child = cancellation.clone();
        let journal_task = journal.clone();
        let task = tokio::spawn(async move {
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal_task.as_ref(),
                    &child,
                    if cancel {
                        deadline()
                    } else {
                        Instant::now() + Duration::from_millis(1000)
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), model.entered.notified())
            .await
            .unwrap();
        if cancel {
            cancellation.cancel();
        }
        assert!(task.await.unwrap().is_err());
        assert_eq!(model.dropped.load(Ordering::SeqCst), 1);
        assert_eq!(model.responses.load(Ordering::SeqCst), 0);
        assert_eq!(journal.state.lock().unwrap().phase(), Phase::Compacting);
        assert!(
            !journal
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "compaction.completed")
        );
    }
}
#[test]
fn compaction_state_is_closed_and_only_allows_settled_tool_boundaries() {
    let channel = make_channel("owner");
    let mut snapshot = initial(&channel).snapshot();
    snapshot.as_object_mut().unwrap().remove("compaction");
    assert!(State::restore(snapshot.clone(), &channel).is_ok());
    for invalid in [
        json!({"active":{"threshold":0,"recent_window":10},"last_input_tokens":null,"last_prompt_messages":null}),
        json!({"active":null,"last_input_tokens":10,"last_prompt_messages":null}),
        json!({"active":null,"last_input_tokens":null,"last_prompt_messages":null,"extra":true}),
    ] {
        snapshot["compaction"] = invalid;
        assert!(State::restore(snapshot.clone(), &channel).is_err());
    }
    snapshot["compaction"] = json!({"active":{"threshold":800,"recent_window":10},"last_input_tokens":null,"last_prompt_messages":null});
    assert!(State::restore(snapshot.clone(), &channel).is_err());
    snapshot["phase"] = json!("compacting");
    assert!(State::restore(snapshot.clone(), &channel).is_ok());
    snapshot["calls"] = json!([{"id":"call","name":"read_file","input":{},"input_hash":null,"phase":"queued","request_id":null,"decision":null,"output":null}]);
    assert!(State::restore(snapshot, &channel).is_err());
}

#[tokio::test]
async fn unreviewable_write_inputs_fail_before_approval_or_any_external_effect() {
    for code in [
        "λ".repeat(80_000),
        "return 'Bearer fixture-credential-should-not-display'".into(),
    ] {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![vec![call(
            "execute_program",
            json!({"language":"javascript","code":code,"capabilityManifest":[{"id":"teams.update","version":"1","maximumCalls":1}]}),
        )]]));
        let sandbox = Arc::new(FakeSandbox::default());
        let (engine, calls) = setup(model, journal.clone(), Some(sandbox.clone()));
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
        assert_eq!(state.phase(), Phase::Complete);
        assert_eq!(sandbox.runs.load(Ordering::SeqCst), 0);
        assert!(calls.requests.lock().unwrap().is_empty());
        let events = journal.normalized();
        assert!(!events.iter().any(|e| e["type"] == "approval.requested"));
        assert!(state.history().iter().any(|m| {
            m.to_string()
                .contains("approval input cannot be displayed safely")
        }));
        for event in events {
            let event = forge_core::agents::presentation::native_event(event).unwrap();
            assert!(forge_core::agents::contracts::safe_payload(&event["payload"]).is_ok());
        }
    }
}
