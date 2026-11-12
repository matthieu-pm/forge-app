use super::*;
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::agents::runtime::{self, Runtime as AgentRuntime};
use forge_store::agents::coordinator::{Hosted, Service};
use futures_util::{StreamExt, TryStreamExt};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Default)]
struct RuntimeFixture {
    start: Mutex<Vec<Value>>,
    resume: Mutex<Vec<Value>>,
    reconnect: Mutex<Vec<Value>>,
    contexts: Mutex<Vec<runtime::Context>>,
    responses: Mutex<Vec<Value>>,
    starts: AtomicUsize,
    reconnects: AtomicUsize,
    cancels: AtomicUsize,
    native: AtomicBool,
    resume_errors: AtomicUsize,
}
fn scripted(context: runtime::Context, steps: Vec<Value>) -> runtime::Events {
    Box::pin(futures_util::stream::try_unfold(
        (context, steps.into_iter()),
        |(context, mut steps)| async move {
            loop {
                match steps.next() {
                    None => return Ok(None),
                    Some(v) if v["checkpoint"] == true => {
                        context
                            .checkpoint
                            .save(if let Some(proof) = v.get("proof") {
                                format!(
                                    "input:{}",
                                    json!({
                                        "run":context.run_id,
                                        "head":proof["head"].as_str().unwrap_or(&context.run_id),
                                        "owner":proof["owner"].as_str().unwrap_or(&context.run_id),
                                        "pending":proof["pending"],
                                        "complete":proof["complete"],
                                    })
                                )
                            } else {
                                format!(
                                    "{}:{}",
                                    v["settled"].as_str().unwrap_or("cursor"),
                                    context.run_id
                                )
                            })
                            .await?
                    }
                    Some(v) if v["error"] == true => {
                        return Err(runtime::Error("private-provider-error"));
                    }
                    Some(v) if v["pending"] == true => std::future::pending::<()>().await,
                    Some(v) => return Ok(Some((v, (context, steps)))),
                }
            }
        },
    ))
}
#[async_trait]
impl AgentRuntime for RuntimeFixture {
    fn kind(&self) -> &'static str {
        "eve"
    }
    fn cursor_run_id(&self, cursor: &str) -> Option<String> {
        self.native.load(Ordering::SeqCst).then_some(())?;
        if let Some(value) = cursor.strip_prefix("input:") {
            let value: Value = serde_json::from_str(value).ok()?;
            return Some(value["run"].as_str()?.to_owned());
        }
        let (kind, run) = cursor.split_once(':')?;
        matches!(kind, "cursor" | "admitted" | "questions" | "complete").then(|| run.to_owned())
    }
    fn question_continuation_run(&self, cursor: &str, terminal: bool) -> Option<String> {
        let owner = self.cursor_run_id(cursor)?;
        (cursor.starts_with("questions:")
            || (terminal && (cursor.starts_with("admitted:") || cursor.starts_with("complete:"))))
        .then_some(owner)
    }
    fn input_continuation(&self, cursor: &str) -> Option<runtime::Continuation> {
        self.native.load(Ordering::SeqCst).then_some(())?;
        let value: Value = serde_json::from_str(cursor.strip_prefix("input:")?).ok()?;
        Some(runtime::Continuation {
            head_run_id: value["head"].as_str()?.to_owned(),
            owner_run_id: value["owner"].as_str()?.to_owned(),
            pending_inputs: value["pending"].as_bool()?,
            delivery_complete: value["complete"].as_bool()?,
        })
    }
    fn idempotent_resumption(&self) -> bool {
        self.native.load(Ordering::SeqCst)
    }
    fn cancel_after_transport_failure(&self) -> bool {
        self.native.load(Ordering::SeqCst)
    }
    fn start(&self, c: runtime::Context, _: String, _: Vec<Value>) -> runtime::Events {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.contexts.lock().unwrap().push(c.clone());
        scripted(c, self.start.lock().unwrap().clone())
    }
    fn resume(&self, c: runtime::Context, responses: Vec<Value>) -> runtime::Events {
        self.responses.lock().unwrap().extend(responses);
        self.contexts.lock().unwrap().push(c.clone());
        if self
            .resume_errors
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_sub(1))
            .is_ok()
        {
            scripted(c, vec![json!({"error":true})])
        } else {
            scripted(c, self.resume.lock().unwrap().clone())
        }
    }
    fn reconnect(&self, c: runtime::Context) -> runtime::Events {
        self.reconnects.fetch_add(1, Ordering::SeqCst);
        self.contexts.lock().unwrap().push(c.clone());
        scripted(c, self.reconnect.lock().unwrap().clone())
    }
    async fn cancel(
        &self,
        _: &str,
        _: Option<&str>,
        _: Option<&runtime::Context>,
    ) -> Result<(), runtime::Error> {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
async fn setup(f: &Fixture) -> (Service, Arc<RuntimeFixture>, Value) {
    let provider = Arc::new(discovery::Provider::default());
    let vault =
        Arc::new(forge_identity::model_vault::Vault::new(&STANDARD.encode([7; 32])).unwrap());
    let mut models = model_connections::Service::new(f.database.clone(), provider, vault);
    models.now = Arc::new(at);
    models.create(&f.actor,json!({"provider":"openai","scope":"personal","displayName":"Fixture API","apiKey":"fixture-secret"})).await.unwrap();
    let catalog = models.catalog(&f.actor, true).await.unwrap().remove(0);
    let runtime = Arc::new(RuntimeFixture::default());
    let mut service = Service::new(f.database.clone());
    service.now = Arc::new(at);
    service.hosted = Some(Arc::new(Hosted::new(
        Arc::new(models),
        vec![runtime.clone()],
    )));
    (service, runtime, catalog)
}
fn pick(v: Value, keys: &[&str]) -> Value {
    Value::Object(keys.iter().map(|k| ((*k).into(), v[*k].clone())).collect())
}
fn input(thread: Uuid, model: &Value) -> Value {
    json!({"threadId":thread,"message":"Summarize this workspace","selectionMode":"manual","model":pick(model.clone(),&["selectionId","connectionId","executionKind","provider","modelId"]),"reasoningEffort":"high","attachmentIds":[]})
}
fn event(id: &str, kind: &str, payload: Value) -> Value {
    json!({"sourceEventId":id,"source":"eve","type":kind,"payload":payload})
}
fn delta() -> Value {
    event(
        "eve:delta",
        "assistant.delta",
        json!({"messageId":"message","delta":"Hello"}),
    )
}
fn question(id: &str, kind: &str) -> Value {
    event(
        id,
        "run.waiting",
        json!({"reason":"input-required","request":{"requestId":id,"kind":kind,"display":"text","prompt":"Which name?","allowFreeform":true,"action":{"callId":id,"kind":"tool-call","toolName":"ask_question","input":{"prompt":"Which name?","allowFreeform":true}}}}),
    )
}

#[tokio::test]
async fn ordinary_question_continuation_requires_a_drained_batch_and_fences_old_checkpoints() {
    let f = Fixture::new().await;
    let (service, runtime, model) = setup(&f).await;
    runtime.native.store(true, Ordering::SeqCst);
    *runtime.start.lock().unwrap() = vec![
        json!({"checkpoint":true}),
        question("question-a", "question"),
        question("question-b", "question"),
        json!({"checkpoint":true,"settled":"questions"}),
    ];
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let mut first = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    let first_id = first.run.id;
    while first.events.next().await.unwrap().unwrap().kind != "run.waiting" {}
    // The first public question is not proof that every remaining batch entry
    // is an ordinary question. A later entry could still request approval.
    assert!(matches!(
        service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await,
        Err(StoreError::Conflict)
    ));
    let remaining: Vec<Event> = first.events.try_collect().await.unwrap();
    assert!(
        remaining
            .iter()
            .any(|event| event.payload["request"]["requestId"] == "question-b")
    );
    let old = runtime.contexts.lock().unwrap().last().unwrap().clone();
    let first_cursor = format!("questions:{first_id}");
    *runtime.start.lock().unwrap() = vec![
        json!({"checkpoint":true}),
        delta(),
        json!({"checkpoint":true,"settled":"complete"}),
    ];
    let mut answer = input(thread.id, &model);
    answer["message"] = json!("Marigold");
    let second = service.start_turn(&f.actor, answer, None).await.unwrap();
    let second_id = second.run.id;
    // Even before the successor's first network call, the old stream is fenced.
    assert!(old.checkpoint.save(first_cursor.clone()).await.is_err());
    second.events.try_collect::<Vec<_>>().await.unwrap();
    assert_eq!(
        runtime
            .contexts
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .runtime_session_id,
        Some(first_cursor)
    );
    assert!(
        old.checkpoint
            .save("stale-question-head".into())
            .await
            .is_err()
    );
    let old_row = current(&f, first_id).await;
    assert_eq!(old_row.state, RunState::WaitingForApproval);
    assert_eq!(old_row.completed_at, None);
    assert_eq!(current(&f, second_id).await.state, RunState::Completed);
    assert_eq!(
        threads::get(&f.database, &f.actor.workspace_id, thread.id)
            .await
            .unwrap()
            .unwrap()
            .runtime_session_id,
        Some(format!("complete:{second_id}"))
    );
    // The historical question row remains waiting after the answer completes;
    // it must not block an ordinary third turn against that completed head.
    let third = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    third.events.try_collect::<Vec<_>>().await.unwrap();
    let approvals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_approvals a JOIN agent_runs r ON r.id=a.run_id WHERE r.thread_id=$1")
        .bind(thread.id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(approvals, 0);
    assert_eq!(runtime.cancels.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn composer_continuation_keeps_required_inputs_and_uncertified_runtimes_blocked() {
    for case in 0..4 {
        let f = Fixture::new().await;
        let (service, runtime, model) = setup(&f).await;
        runtime.native.store(case != 0, Ordering::SeqCst);
        let mut steps = vec![
            json!({"checkpoint":true}),
            question(
                "question-a",
                if case == 1 {
                    "session-limit"
                } else {
                    "question"
                },
            ),
        ];
        if case == 2 {
            steps.push(event("approval", "approval.requested", json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Rename a team","details":{"runtimeRequestId":"required-input"},"input":{"name":"Updated"}})));
        }
        if case != 3 {
            steps.push(json!({"checkpoint":true,"settled":"questions"}));
        }
        *runtime.start.lock().unwrap() = steps;
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let first = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let id = first.run.id;
        first.events.try_collect::<Vec<_>>().await.unwrap();
        assert!(
            matches!(
                service
                    .start_turn(&f.actor, input(thread.id, &model), None)
                    .await,
                Err(StoreError::Conflict)
            ),
            "case {case}"
        );
        assert_eq!(current(&f, id).await.state, RunState::WaitingForApproval);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE thread_id=$1")
            .bind(thread.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        if case == 2 {
            let states: Vec<String> =
                sqlx::query_scalar("SELECT state FROM agent_approvals WHERE run_id=$1")
                    .bind(id)
                    .fetch_all(&f.pool)
                    .await
                    .unwrap();
            assert_eq!(states, vec!["pending"]);
        }
    }
}

#[tokio::test]
async fn historical_questions_survive_terminal_answers_but_not_unconfirmed_admission() {
    for terminal_case in ["cancel", "failed", "unconfirmed"] {
        let f = Fixture::new().await;
        let (service, runtime, model) = setup(&f).await;
        runtime.native.store(true, Ordering::SeqCst);
        *runtime.start.lock().unwrap() = vec![
            json!({"checkpoint":true}),
            question("question-a", "question"),
            json!({"checkpoint":true,"settled":"questions"}),
        ];
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let first = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let original = first.run.id;
        first.events.try_collect::<Vec<_>>().await.unwrap();
        *runtime.start.lock().unwrap() = vec![
            json!({"checkpoint":true,"settled":if terminal_case == "unconfirmed" { "cursor" } else { "admitted" }}),
            if terminal_case == "cancel" {
                delta()
            } else {
                event("failure", "run.failed", json!({}))
            },
            json!({"pending":true}),
        ];
        let mut second = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let answer = second.run.id;
        for _ in 0..4 {
            second.events.next().await.unwrap().unwrap();
        }
        if terminal_case == "cancel" {
            service.cancel_run(&f.actor, answer).await.unwrap();
        }
        drop(second);
        *runtime.start.lock().unwrap() = vec![
            json!({"checkpoint":true}),
            delta(),
            json!({"checkpoint":true,"settled":"complete"}),
        ];
        let third = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await;
        if terminal_case == "unconfirmed" {
            assert!(matches!(third, Err(StoreError::Conflict)));
        } else {
            third.unwrap().events.try_collect::<Vec<_>>().await.unwrap();
        }
        assert_eq!(
            current(&f, original).await.state,
            RunState::WaitingForApproval
        );
        assert_eq!(current(&f, original).await.completed_at, None);
    }
}
#[tokio::test]
async fn required_batches_keep_delivery_completion_separate_from_original_approval_authority() {
    let f = Fixture::new().await;
    let (service, runtime, model) = setup(&f).await;
    runtime.native.store(true, Ordering::SeqCst);
    let requests = [Uuid::new_v4(), Uuid::new_v4()];
    *runtime.start.lock().unwrap() = vec![
        event(
            "first-approval",
            "approval.requested",
            json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"First change","details":{"runtimeRequestId":requests[0]},"input":{"name":"First"}}),
        ),
        event(
            "second-approval",
            "approval.requested",
            json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Second change","details":{"runtimeRequestId":requests[1]},"input":{"name":"Second"}}),
        ),
        json!({"checkpoint":true,"proof":{"pending":true,"complete":false}}),
    ];
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let original = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    let a = original.run.id;
    let issued: Vec<Event> = original.events.try_collect().await.unwrap();
    let approvals: Vec<Uuid> = issued
        .iter()
        .filter(|e| e.kind == "approval.requested")
        .map(|e| e.payload["approvalId"].as_str().unwrap().parse().unwrap())
        .collect();
    let old_context = runtime.contexts.lock().unwrap().last().unwrap().clone();
    assert_eq!(current(&f, a).await.state, RunState::WaitingForApproval);
    *runtime.start.lock().unwrap() = vec![
        json!({"checkpoint":true,"proof":{"owner":a,"pending":true,"complete":true}}),
        event("deferred-complete", "run.completed", json!({})),
    ];
    let mut queued_input = input(thread.id, &model);
    queued_input["message"] = json!("Keep that request queued");
    queued_input["reasoningEffort"] = json!("low");
    let queued = service
        .start_turn(&f.actor, queued_input, None)
        .await
        .unwrap();
    let b = queued.run.id;
    assert!(old_context.checkpoint.save("stale".into()).await.is_err());
    queued.events.try_collect::<Vec<_>>().await.unwrap();
    assert_eq!(current(&f, b).await.state, RunState::Completed);
    assert_eq!(current(&f, a).await.state, RunState::WaitingForApproval);
    *runtime.resume.lock().unwrap() = vec![
        json!({"checkpoint":true,"proof":{"head":b,"pending":true,"complete":true}}),
        event("original-complete", "run.completed", json!({})),
    ];
    let first = service
        .resolve_approval(
            &f.actor,
            approvals[0],
            approval_service::Decision::Approved,
            None,
        )
        .await
        .unwrap();
    let first: Vec<Event> = first.events.try_collect().await.unwrap();
    let completion = first.last().unwrap().clone();
    assert_eq!(completion.kind, "run.completed");
    let partial = current(&f, a).await;
    assert_eq!(partial.state, RunState::Completed);
    assert!(partial.completed_at.is_some());
    *runtime.resume.lock().unwrap() = vec![
        json!({"checkpoint":true,"proof":{"head":b,"pending":false,"complete":true}}),
        delta(),
        event("original-complete", "run.completed", json!({})),
    ];
    let second = service
        .resolve_approval(
            &f.actor,
            approvals[1],
            approval_service::Decision::Denied,
            None,
        )
        .await
        .unwrap();
    assert_eq!(second.run.state, RunState::Running);
    assert_eq!(second.run.completed_at, partial.completed_at);
    let second: Vec<Event> = second.events.try_collect().await.unwrap();
    assert_eq!(second.last().unwrap(), &completion);
    assert_eq!(current(&f, a).await.state, RunState::Completed);
    assert_eq!(current(&f, b).await.state, RunState::Completed);
    {
        let contexts = runtime.contexts.lock().unwrap();
        for c in contexts.iter().filter(|c| c.run_id == a.to_string()) {
            assert_eq!(c.reasoning_effort, "high");
            assert_eq!(c.model["connectionId"], model["connectionId"]);
        }
        assert_eq!(contexts.last().unwrap().run_id, a.to_string());
    }
    assert_eq!(
        *runtime.responses.lock().unwrap(),
        vec![
            json!({"requestId":requests[0],"optionId":"approve"}),
            json!({"requestId":requests[1],"optionId":"deny"}),
        ]
    );
    let completions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_events WHERE run_id=$1 AND type='run.completed'",
    )
    .bind(a)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(completions, 1);
    *runtime.start.lock().unwrap() = vec![
        json!({"checkpoint":true,"proof":{"pending":false,"complete":true}}),
        event("third-complete", "run.completed", json!({})),
    ];
    service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap()
        .events
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
}

#[tokio::test]
async fn completed_approval_requires_owned_native_lineage_and_can_follow_a_matching_delivery() {
    for valid in [false, true] {
        let f = Fixture::new().await;
        let (service, runtime, model) = setup(&f).await;
        runtime.native.store(true, Ordering::SeqCst);
        let request = Uuid::new_v4();
        *runtime.start.lock().unwrap() = vec![
            event(
                "approval",
                "approval.requested",
                json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Change","details":{"runtimeRequestId":request}}),
            ),
            json!({"checkpoint":true,"proof":{"pending":true,"complete":false}}),
        ];
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let original = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let a = original.run.id;
        let events: Vec<Event> = original.events.try_collect().await.unwrap();
        let approval: Uuid = events
            .iter()
            .find(|e| e.kind == "approval.requested")
            .unwrap()
            .payload["approvalId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        *runtime.start.lock().unwrap() = vec![
            json!({"checkpoint":true,"proof":{"pending":false,"complete":true}}),
            event("matching-complete", "run.completed", json!({})),
        ];
        let mut text = input(thread.id, &model);
        text["message"] = json!("approve");
        let matching = service.start_turn(&f.actor, text, None).await.unwrap();
        let b = matching.run.id;
        matching.events.try_collect::<Vec<_>>().await.unwrap();
        if !valid {
            let foreign =
                json!({"run":b,"head":b,"owner":Uuid::new_v4(),"pending":false,"complete":true});
            sqlx::query("UPDATE agent_threads SET runtime_session_id=$2 WHERE id=$1")
                .bind(thread.id)
                .bind(format!("input:{foreign}"))
                .execute(&f.pool)
                .await
                .unwrap();
        }
        *runtime.resume.lock().unwrap() = vec![
            json!({"checkpoint":true,"proof":{"head":b,"pending":false,"complete":true}}),
            event("canonical-complete", "run.completed", json!({})),
        ];
        let resumed = service
            .resolve_approval(
                &f.actor,
                approval,
                approval_service::Decision::Approved,
                None,
            )
            .await;
        if valid {
            let resumed = resumed.unwrap();
            assert_eq!(resumed.run.id, a);
            resumed.events.try_collect::<Vec<_>>().await.unwrap();
            assert_eq!(current(&f, a).await.state, RunState::Completed);
            assert_eq!(
                runtime.contexts.lock().unwrap().last().unwrap().run_id,
                a.to_string()
            );
        } else {
            assert!(resumed.is_err());
            assert_eq!(
                approvals::get(&mut f.pool.acquire().await.unwrap(), approval)
                    .await
                    .unwrap()
                    .unwrap()
                    .state,
                ApprovalState::Pending
            );
            assert_eq!(current(&f, a).await.state, RunState::WaitingForApproval);
        }
    }
}

async fn current(f: &Fixture, id: Uuid) -> Run {
    runs::get(&f.database, &f.actor.workspace_id, id)
        .await
        .unwrap()
        .unwrap()
}
fn normalize(v: Value, connection: &str, run: Uuid) -> Value {
    match v {
        Value::String(s) => json!(
            s.replace(connection, "00000000-0000-4000-8000-000000000066")
                .replace(&format!("cursor:{run}"), "fixture-cursor")
        ),
        Value::Array(a) => json!(
            a.into_iter()
                .map(|v| normalize(v, connection, run))
                .collect::<Vec<_>>()
        ),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, v)| (k, normalize(v, connection, run)))
                .collect(),
        ),
        other => other,
    }
}
#[tokio::test]
async fn hosted_streams_match_executed_source_flows() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../../reference-fixtures.json")).unwrap();
    for case in fixtures["coordinator"]["hosted"].as_array().unwrap() {
        let f = Fixture::new().await;
        let (mut service, runtime, model) = setup(&f).await;
        let spec = &case["spec"];
        for key in ["maxInputTokens", "maxOutputTokens"] {
            if let Some(v) = spec.get(key) {
                service.controls[key] = v.clone();
            }
        }
        let mut steps = vec![];
        if spec["checkpoint"] == true {
            steps.push(json!({"checkpoint":true}));
        }
        steps.push(delta());
        if let Some(usage) = spec.get("usage") {
            steps.push(event("eve:usage", "run.usage", usage.clone()));
        }
        if let Some(terminal) = spec["terminal"].as_str() {
            steps.push(event("eve:terminal", terminal, json!({})));
        }
        if spec["error"] == true {
            steps.push(json!({"error":true}));
        }
        *runtime.start.lock().unwrap() = steps;
        *runtime.reconnect.lock().unwrap() = vec![if spec["reconnectError"] == true {
            json!({"error":true})
        } else {
            event(
                "eve:reconnected",
                "assistant.message",
                json!({"messageId":"message","text":"Hello"}),
            )
        }];
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let session = service
            .start_turn(
                &f.actor,
                input(thread.id, &model),
                Some("fixture-correlation".into()),
            )
            .await
            .unwrap();
        let id = session.run.id;
        assert_eq!(runtime.starts.load(Ordering::SeqCst), 0);
        let result: Vec<Event> = session.events.try_collect().await.unwrap();
        let actual = json!(
            result
                .into_iter()
                .map(|e| pick(
                    json!(e),
                    &["sequence", "occurredAt", "source", "type", "payload"]
                ))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            normalize(actual, model["connectionId"].as_str().unwrap(), id),
            case["events"],
            "{spec}"
        );
        let run = current(&f, id).await;
        let actual = pick(
            json!(run),
            &[
                "state",
                "executionKind",
                "requestedSelection",
                "resolvedModelId",
                "reasoningEffort",
                "routingPolicyVersion",
                "routingReason",
                "runtimeRunId",
                "inputTokens",
                "outputTokens",
                "cachedInputTokens",
                "costMicros",
                "startedAt",
                "completedAt",
                "errorCode",
            ],
        );
        assert_eq!(
            normalize(actual, model["connectionId"].as_str().unwrap(), id),
            case["run"],
            "{spec}"
        );
        assert_eq!(
            runtime.cancels.load(Ordering::SeqCst) as u64,
            case["cancelled"].as_u64().unwrap()
        );
        let contexts = runtime.contexts.lock().unwrap();
        assert_eq!(contexts[0].identity.workspace_role, "admin");
        assert_eq!(
            contexts[0].correlation_id.as_deref(),
            Some("fixture-correlation")
        );
        if spec["checkpoint"] == true {
            assert_eq!(
                contexts.last().unwrap().runtime_session_id,
                Some(format!("cursor:{id}"))
            );
        }
    }
}
#[tokio::test]
async fn hosted_replay_counts_usage_once_and_terminal_events_stop_late_writes() {
    let f = Fixture::new().await;
    let (service, runtime, model) = setup(&f).await;
    let usage = event(
        "usage",
        "run.usage",
        json!({"inputTokens":9,"costMicros":7}),
    );
    *runtime.start.lock().unwrap() = vec![
        usage.clone(),
        usage,
        event("done", "run.failed", json!({})),
        delta(),
    ];
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let session = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    let id = session.run.id;
    let result: Vec<Event> = session.events.try_collect().await.unwrap();
    assert_eq!(result[3], result[4]);
    assert_eq!(result.last().unwrap().kind, "run.failed");
    let run = current(&f, id).await;
    assert_eq!(
        (run.input_tokens, run.cost_micros, run.state),
        (9, 7, RunState::Failed)
    );
    assert!(matches!(
        service.cancel_run(&f.actor, id).await,
        Err(StoreError::Conflict)
    ));
}
#[tokio::test]
async fn cancellation_and_revocation_prevent_lazy_runtime_start_and_late_checkpoints() {
    let f = Fixture::new().await;
    let (service, runtime, model) = setup(&f).await;
    *runtime.start.lock().unwrap() = vec![
        json!({"checkpoint":true}),
        delta(),
        event("late", "assistant.delta", json!({"delta":"late"})),
    ];
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let mut session = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    let cancelled = service.cancel_run(&f.actor, session.run.id).await.unwrap();
    assert_eq!(
        service.cancel_run(&f.actor, session.run.id).await.unwrap(),
        cancelled
    );
    assert!(session.events.next().await.is_none());
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 0);
    let mut session = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    for _ in 0..4 {
        session.events.next().await.unwrap().unwrap();
    }
    let context = runtime.contexts.lock().unwrap().last().unwrap().clone();
    service.cancel_run(&f.actor, session.run.id).await.unwrap();
    assert!(context.checkpoint.save("late-cursor".into()).await.is_err());
    assert!(session.events.next().await.is_none());
    let mut session = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        session.events.next().await.unwrap(),
        Err(StoreError::Forbidden)
    ));
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn approval_resume_transfers_stream_ownership_and_rejects_terminal_resolution() {
    for decision in [
        approval_service::Decision::Approved,
        approval_service::Decision::Denied,
    ] {
        let f = Fixture::new().await;
        let (service, runtime, model) = setup(&f).await;
        *runtime.start.lock().unwrap() = vec![
            json!({"checkpoint":true}),
            event(
                "approval",
                "approval.requested",
                json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Rename a team","details":{"runtimeRequestId":"eve-input"},"input":{"name":"Updated"}}),
            ),
            event("stale-waiting", "run.waiting", json!({})),
        ];
        *runtime.resume.lock().unwrap() = vec![delta()];
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let mut original = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let id = original.run.id;
        for _ in 0..3 {
            original.events.next().await.unwrap().unwrap();
        }
        let approval = original.events.next().await.unwrap().unwrap();
        let approval_id: Uuid = approval.payload["approvalId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let old_context = runtime.contexts.lock().unwrap().last().unwrap().clone();
        let resumed = service
            .resolve_approval(&f.actor, approval_id, decision, None)
            .await
            .unwrap();
        assert!(old_context.checkpoint.save("stale".into()).await.is_err());
        assert!(original.events.next().await.is_none());
        let result: Vec<Event> = resumed.events.try_collect().await.unwrap();
        assert_eq!(result[0].kind, "approval.resolved");
        assert_eq!(result.last().unwrap().kind, "run.completed");
        assert_eq!(current(&f, id).await.state, RunState::Completed);
        assert_eq!(
            *runtime.responses.lock().unwrap(),
            vec![
                json!({"requestId":"eve-input","optionId":match decision{approval_service::Decision::Approved=>"approve",approval_service::Decision::Denied=>"deny"}})
            ]
        );
        assert!(
            service
                .resolve_approval(&f.actor, approval_id, decision, None)
                .await
                .is_err()
        );
    }
}
#[tokio::test]
async fn approval_after_cancel_cannot_resurrect_run_and_expiry_commits() {
    let f = Fixture::new().await;
    let (mut service, runtime, model) = setup(&f).await;
    *runtime.start.lock().unwrap() = vec![
        json!({"checkpoint":true}),
        event(
            "approval",
            "approval.requested",
            json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Rename","details":{"runtimeRequestId":"eve-input"}}),
        ),
    ];
    for expires in [false, true] {
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let session = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let run = session.run.id;
        let events: Vec<Event> = session.events.try_collect().await.unwrap();
        let approval: Uuid = events.last().unwrap().payload["approvalId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        if expires {
            service.now = Arc::new(|| at() + Duration::minutes(6));
        } else {
            service.cancel_run(&f.actor, run).await.unwrap();
        }
        assert!(
            service
                .resolve_approval(
                    &f.actor,
                    approval,
                    approval_service::Decision::Approved,
                    None
                )
                .await
                .is_err()
        );
        let stored = approvals::get(&mut f.pool.acquire().await.unwrap(), approval)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.state,
            if expires {
                ApprovalState::Expired
            } else {
                ApprovalState::Pending
            }
        );
        if !expires {
            assert_eq!(current(&f, run).await.state, RunState::Cancelled);
        }
    }
}
#[tokio::test]
async fn hosted_wall_clock_limit_cancels_without_completing_and_bad_payload_is_redacted() {
    let f = Fixture::new().await;
    let (mut service, runtime, model) = setup(&f).await;
    service.controls["runWallClockMs"] = json!(10);
    for malformed in [false, true] {
        *runtime.start.lock().unwrap() = vec![if malformed {
            event(
                "unsafe",
                "assistant.message",
                json!({"access_token":"private-provider-secret"}),
            )
        } else {
            json!({"pending":true})
        }];
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let session = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let result: Vec<Event> = session.events.try_collect().await.unwrap();
        let last = result.last().unwrap();
        assert_eq!(last.kind, "run.failed");
        assert_eq!(
            last.payload["errorCode"],
            if malformed {
                "RUNTIME_EXECUTION_FAILED"
            } else {
                "RUN_WALL_CLOCK_LIMIT"
            }
        );
        assert!(
            !json!(result)
                .to_string()
                .contains("private-provider-secret")
        );
    }
    assert_eq!(runtime.cancels.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn admission_rejects_spoofed_provider_and_concurrent_turns() {
    let f = Fixture::new().await;
    let (service, _, model) = setup(&f).await;
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let mut spoofed = input(thread.id, &model);
    spoofed["model"]["provider"] = json!("anthropic");
    assert!(service.start_turn(&f.actor, spoofed, None).await.is_err());
    let (a, b) = tokio::join!(
        service.start_turn(&f.actor, input(thread.id, &model), None),
        service.start_turn(&f.actor, input(thread.id, &model), None)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_runs WHERE thread_id=$1")
        .bind(thread.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn reconnect_keeps_live_credentials_but_never_renews_the_deadline() {
    let f = Fixture::new().await;
    let (mut service, runtime, model) = setup(&f).await;
    service.controls["runWallClockMs"] = json!(200);
    *runtime.start.lock().unwrap() =
        vec![json!({"checkpoint":true}), delta(), json!({"error":true})];
    *runtime.reconnect.lock().unwrap() =
        vec![event("late", "assistant.delta", json!({"delta":"late"}))];
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let mut session = service
        .start_turn(&f.actor, input(thread.id, &model), None)
        .await
        .unwrap();
    for _ in 0..5 {
        session.events.next().await.unwrap().unwrap();
    }
    assert_eq!(
        current(&f, session.run.id).await.state,
        RunState::Reconnecting
    );
    let agent = Actor {
        authentication: Authentication::Agent {
            run_id: session.run.id.to_string(),
            token_id: "fixture".into(),
        },
        ..f.actor.clone()
    };
    let mut conn = f.pool.acquire().await.unwrap();
    assert!(
        forge_store::authority::current_actor(&mut conn, &agent)
            .await
            .is_ok()
    );
    drop(conn);
    tokio::time::sleep(std::time::Duration::from_millis(220)).await;
    let failed = session.events.next().await.unwrap().unwrap();
    assert_eq!(failed.payload["errorCode"], "RUN_WALL_CLOCK_LIMIT");
    assert_eq!(runtime.cancels.load(Ordering::SeqCst), 1);
    let mut conn = f.pool.acquire().await.unwrap();
    assert!(
        forge_store::authority::current_actor(&mut conn, &agent)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_resume_retries_the_same_decision_keeps_the_original_deadline_and_revokes_after_failure()
 {
    for errors in [1, 2] {
        let f = Fixture::new().await;
        let (mut service, runtime, model) = setup(&f).await;
        runtime.native.store(true, Ordering::SeqCst);
        runtime.resume_errors.store(errors, Ordering::SeqCst);
        *runtime.start.lock().unwrap() = vec![
            json!({"checkpoint":true}),
            event(
                "approval",
                "approval.requested",
                json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Rename","details":{"runtimeRequestId":"native-input"},"input":{"name":"Updated"}}),
            ),
        ];
        *runtime.resume.lock().unwrap() = vec![delta()];
        let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
        let session = service
            .start_turn(&f.actor, input(thread.id, &model), None)
            .await
            .unwrap();
        let id = session.run.id;
        let events: Vec<Event> = session.events.try_collect().await.unwrap();
        let approval_id = events
            .iter()
            .find(|e| e.kind == "approval.requested")
            .unwrap()
            .payload["approvalId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let deadline = runtime.contexts.lock().unwrap()[0].deadline_ms;
        service.now = Arc::new(|| at() + chrono::Duration::seconds(30));
        let resumed = service
            .resolve_approval(
                &f.actor,
                approval_id,
                approval_service::Decision::Approved,
                None,
            )
            .await
            .unwrap();
        let events: Vec<Event> = resumed.events.try_collect().await.unwrap();
        assert_eq!(
            events.last().unwrap().kind,
            if errors == 1 {
                "run.completed"
            } else {
                "run.failed"
            }
        );
        assert_eq!(
            current(&f, id).await.state,
            if errors == 1 {
                RunState::Completed
            } else {
                RunState::Failed
            }
        );
        assert_eq!(runtime.reconnects.load(Ordering::SeqCst), 0);
        assert_eq!(
            runtime.cancels.load(Ordering::SeqCst),
            usize::from(errors == 2)
        );
        assert_eq!(
            *runtime.responses.lock().unwrap(),
            vec![json!({"requestId":"native-input","optionId":"approve"}); 2]
        );
        assert!(
            runtime
                .contexts
                .lock()
                .unwrap()
                .iter()
                .all(|c| c.deadline_ms == deadline)
        );
        assert_eq!(deadline, at().timestamp_millis() + 900000);
    }
}
