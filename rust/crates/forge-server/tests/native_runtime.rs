#[path = "support/native_runtime.rs"]
mod support;
use async_trait::async_trait;
use forge_agent_runtime::auth::Channel;
use forge_core::agents::{
    runtime::{Checkpoint, Context, Error, Identity, Runtime},
    tokens::{Kind, mint},
};
use forge_server::native_runtime::{Cursor, NativeRuntime};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use support::{Fixture, Mode, SECRET};
use uuid::Uuid;
#[derive(Default)]
struct Saved {
    values: Mutex<Vec<String>>,
    fail: AtomicBool,
}
impl Saved {
    fn last(&self) -> String {
        self.values.lock().unwrap().last().unwrap().clone()
    }
}
#[async_trait]
impl Checkpoint for Saved {
    async fn save(&self, cursor: String) -> Result<(), Error> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(Error("Fixture checkpoint unavailable."));
        }
        assert!(Cursor::decode(&cursor).is_some());
        self.values.lock().unwrap().push(cursor);
        Ok(())
    }
    async fn clear(&self) -> Result<(), Error> {
        self.values.lock().unwrap().clear();
        Ok(())
    }
}
fn context(saved: Arc<Saved>) -> Context {
    Context {
        thread_id: Uuid::new_v4().to_string(),
        run_id: Uuid::new_v4().to_string(),
        identity: Identity {
            workspace_id: "fixture-workspace".into(),
            user_id: "fixture-user".into(),
            workspace_role: "owner".into(),
        },
        model: json!({"connectionId":Uuid::new_v4(),"provider":"openai","modelId":"fixture-model"}),
        reasoning_effort: "medium".into(),
        deadline_ms: chrono::Utc::now().timestamp_millis() + 60000,
        runtime_session_id: None,
        correlation_id: None,
        checkpoint: saved,
    }
}
fn channel(context: &Context) -> Channel {
    let now = chrono::Utc::now().timestamp();
    let token=mint(SECRET,Kind::RuntimeChannel,json!({"sub":context.identity.user_id,"workspaceId":context.identity.workspace_id,"runId":context.run_id,"forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-access-token","provider":context.model["provider"],"modelId":context.model["modelId"],"reasoningEffort":"medium"}),now,900.).unwrap();
    Channel::verify(SECRET, &format!("Bearer {token}"), now).unwrap()
}
async fn collect(events: forge_core::agents::runtime::Events) -> Vec<Value> {
    events
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .collect()
}
#[tokio::test]
async fn actual_native_service_handles_approval_continuation_next_turn_and_provider_switch() {
    let f = Fixture::new(Mode::Approve, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved.clone());
    let events = collect(runtime.start(ctx.clone(), "Remember marigold".into(), vec![])).await;
    let approval = events
        .iter()
        .find(|e| e["type"] == "approval.requested")
        .unwrap();
    let request = approval["payload"]["details"]["runtimeRequestId"]
        .as_str()
        .unwrap();
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    ctx.runtime_session_id = Some(saved.last());
    let waiting = collect(runtime.reconnect(ctx.clone())).await;
    assert!(waiting.iter().any(|e| e["type"] == "run.waiting"));
    assert!(
        !waiting
            .iter()
            .any(|e| e["type"] == "approval.requested" || e["type"] == "run.completed")
    );
    ctx.runtime_session_id = Some(saved.last());
    let done = collect(runtime.resume(
        ctx.clone(),
        vec![json!({"requestId":request,"optionId":"approve"})],
    ))
    .await;
    assert!(done.iter().any(|e| e["type"] == "run.completed"));
    assert!(
        done.iter()
            .any(|e| e["payload"]["content"] == "The marker is marigold.")
    );
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 1);
    let first = ctx.run_id.clone();
    ctx.runtime_session_id = Some(saved.last());
    ctx.run_id = Uuid::new_v4().to_string();
    ctx.model["provider"] = json!("anthropic");
    ctx.model["connectionId"] = json!(Uuid::new_v4());
    let next = collect(runtime.start(ctx.clone(), "What is the marker?".into(), vec![])).await;
    assert!(next.iter().any(|e| e["type"] == "run.completed"));
    let cursor = Cursor::decode(&saved.last()).unwrap();
    assert_eq!(cursor.conversation_id.to_string(), ctx.thread_id);
    assert_eq!(cursor.previous_run_id.unwrap().to_string(), first);
    let state = f.store.load(&channel(&ctx)).await.unwrap().state;
    assert_eq!(state.history()[1]["content"], "Remember marigold");
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 1);
    assert_eq!(
        *f.script.output_limits.lock().unwrap(),
        vec![50000, 49995, 49990]
    );
    f.shutdown().await;
}

#[tokio::test]
async fn ordinary_question_batch_replays_and_consumes_a_composer_answer_once() {
    let f = Fixture::new(Mode::Questions, true).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved.clone());
    let original_run = ctx.run_id.clone();
    let mut stream = runtime.start(ctx.clone(), "Choose a flower".into(), vec![]);
    let first = loop {
        let event = stream.next().await.unwrap().unwrap();
        if event["type"] == "run.waiting" {
            break event;
        }
    };
    assert_eq!(
        first["payload"]["request"]["requestId"],
        "opaque-question-choice"
    );
    assert_eq!(first["payload"]["request"]["kind"], "question");
    assert!(
        runtime
            .question_continuation_run(&saved.last(), false)
            .is_none()
    );
    let rest = collect(stream).await;
    assert!(
        rest.iter()
            .any(|event| event["payload"]["request"]["requestId"] == "opaque-question-text")
    );
    assert_eq!(
        runtime.question_continuation_run(&saved.last(), false),
        Some(original_run)
    );
    ctx.runtime_session_id = Some(saved.last());
    let replay = collect(runtime.reconnect(ctx.clone())).await;
    let requests: Vec<_> = replay
        .iter()
        .filter(|event| event["type"] == "run.waiting")
        .map(|event| event["payload"]["request"].clone())
        .collect();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], first["payload"]["request"]);
    assert!(
        !replay
            .iter()
            .any(|event| event["type"] == "approval.requested")
    );
    assert_eq!(f.script.models.load(Ordering::SeqCst), 1);

    ctx.runtime_session_id = Some(saved.last());
    ctx.run_id = Uuid::new_v4().to_string();
    let answer = collect(runtime.start(ctx.clone(), "2".into(), vec![])).await;
    assert_eq!(answer.last().unwrap()["type"], "run.completed");
    assert_eq!(
        runtime.question_continuation_run(&saved.last(), true),
        Some(ctx.run_id.clone())
    );
    {
        let results = f.script.question_results.lock().unwrap();
        assert!(
            results
                .iter()
                .any(|part| part["toolCallId"] == "opaque-question-choice"
                    && part["output"]["value"]["status"] == "answered"
                    && part["output"]["value"]["optionId"] == "b")
        );
        assert!(
            results
                .iter()
                .any(|part| part["toolCallId"] == "opaque-question-text"
                    && part["output"]["value"]["text"] == "2")
        );
    }
    ctx.runtime_session_id = Some(saved.last());
    let retried = collect(runtime.start(ctx.clone(), "2".into(), vec![])).await;
    assert_eq!(retried.last().unwrap()["type"], "run.completed");
    assert_eq!(f.script.models.load(Ordering::SeqCst), 2);
    ctx.runtime_session_id = Some(saved.last());
    ctx.run_id = Uuid::new_v4().to_string();
    assert_eq!(
        collect(runtime.start(ctx, "Thanks".into(), vec![]))
            .await
            .last()
            .unwrap()["type"],
        "run.completed"
    );
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    f.shutdown().await;
}
#[tokio::test]
async fn required_input_deliveries_preserve_original_authority_and_current_conversation_history() {
    for matching in [false, true] {
        let f = Fixture::new(Mode::MixedRequired, true).await;
        let runtime = NativeRuntime::new(f.options()).unwrap();
        let saved = Arc::new(Saved::default());
        let mut a = context(saved.clone());
        let initial = collect(runtime.start(
            a.clone(),
            "Remember marigold and make two changes".into(),
            vec![],
        ))
        .await;
        let requests: Vec<String> = initial
            .iter()
            .filter(|e| e["type"] == "approval.requested")
            .map(|e| {
                e["payload"]["details"]["runtimeRequestId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(requests.len(), 2);
        assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
        assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
        assert!(
            runtime
                .input_continuation(&saved.last())
                .unwrap()
                .pending_inputs
        );
        a.runtime_session_id = Some(saved.last());
        let replay = collect(runtime.reconnect(a.clone())).await;
        assert!(replay.iter().any(|event| event["type"] == "run.waiting"));
        assert!(
            !replay
                .iter()
                .any(|event| event["type"] == "approval.requested")
        );
        let mut b = a.clone();
        b.run_id = Uuid::new_v4().to_string();
        b.runtime_session_id = Some(saved.last());
        b.model["provider"] = json!("anthropic");
        b.model["connectionId"] = json!(Uuid::new_v4());
        let delivered = collect(
            runtime.start(
                b.clone(),
                if matching {
                    "yes"
                } else {
                    "Please keep the changes queued"
                }
                .into(),
                vec![],
            ),
        )
        .await;
        assert_eq!(delivered.last().unwrap()["type"], "run.completed");
        let proof = runtime.input_continuation(&saved.last()).unwrap();
        assert_eq!(proof.head_run_id, b.run_id);
        assert_eq!(
            proof.owner_run_id,
            if matching { &b.run_id } else { &a.run_id }.to_owned()
        );
        assert_eq!(proof.pending_inputs, !matching);
        assert!(proof.delivery_complete);
        assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
        if matching {
            assert_eq!(
                *f.script.callback_runs.lock().unwrap(),
                vec![b.run_id.clone(), b.run_id.clone()]
            );
            assert_eq!(
                f.script.model_runs.lock().unwrap().last().unwrap(),
                &(b.run_id.clone(), "anthropic".into())
            );
        } else {
            assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
        }
        a.runtime_session_id = Some(saved.last());
        let first = collect(runtime.resume(
            a.clone(),
            vec![json!({"requestId":requests[0],"optionId":"approve"})],
        ))
        .await;
        assert_eq!(first.last().unwrap()["type"], "run.completed");
        if !matching {
            assert!(
                runtime
                    .input_continuation(&saved.last())
                    .unwrap()
                    .pending_inputs
            );
            assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
            assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
            a.runtime_session_id = Some(saved.last());
            let second = collect(runtime.resume(
                a.clone(),
                vec![json!({"requestId":requests[1],"optionId":"deny"})],
            ))
            .await;
            assert_eq!(second.last().unwrap()["type"], "run.completed");
            assert_eq!(
                first.last().unwrap()["sourceEventId"],
                second.last().unwrap()["sourceEventId"]
            );
            assert_eq!(f.script.effects.load(Ordering::SeqCst), 1);
            assert_eq!(
                *f.script.callback_runs.lock().unwrap(),
                vec![a.run_id.clone()]
            );
        }
        let proof = runtime.input_continuation(&saved.last()).unwrap();
        assert_eq!(proof.head_run_id, b.run_id);
        assert_eq!(proof.owner_run_id, a.run_id);
        assert!(!proof.pending_inputs);
        assert_eq!(
            f.script.model_runs.lock().unwrap().last().unwrap(),
            &(a.run_id.clone(), "openai".into())
        );
        let mut c = b.clone();
        c.run_id = Uuid::new_v4().to_string();
        c.runtime_session_id = Some(saved.last());
        let next = collect(runtime.start(c.clone(), "What is the marker?".into(), vec![])).await;
        assert!(
            next.iter()
                .any(|e| e["payload"]["content"] == "The marker is marigold.")
        );
        assert_eq!(next.last().unwrap()["type"], "run.completed");
        let cursor = Cursor::decode(&saved.last()).unwrap();
        assert_eq!(cursor.previous_run_id.unwrap().to_string(), b.run_id);
        assert_eq!(
            cursor.conversation.unwrap().owner_run_id.to_string(),
            c.run_id
        );
        assert_eq!(
            f.script.effects.load(Ordering::SeqCst),
            usize::from(!matching)
        );
        f.shutdown().await;
    }
}

#[tokio::test]
async fn cursor_advances_only_after_delivery_and_reconnect_replays_the_unacknowledged_event() {
    let f = Fixture::new(Mode::Finish, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved.clone());
    let mut stream = runtime.start(ctx.clone(), "Hello".into(), vec![]);
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(first["type"], "assistant.message");
    let index = Cursor::decode(&saved.last()).unwrap().stream_index;
    let raw = f.store.events(&channel(&ctx), index, 1).await.unwrap();
    assert_eq!(raw[0].value["type"], "message.completed");
    assert_eq!(raw[0].value["data"]["message"], first["payload"]["content"]);
    drop(stream);
    ctx.runtime_session_id = Some(saved.last());
    let replay = collect(runtime.reconnect(ctx.clone())).await;
    assert_eq!(replay[0]["sourceEventId"], first["sourceEventId"]);
    assert!(replay.iter().any(|e| e["type"] == "run.completed"));
    assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
    f.shutdown().await;
}
#[tokio::test]
async fn checkpoint_failure_and_lost_admission_acknowledgement_recover_without_repeating_model_work()
 {
    let f = Fixture::new(Mode::Finish, true).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved.clone());
    let mut stream = runtime.start(ctx.clone(), "Hello".into(), vec![]);
    stream.next().await.unwrap().unwrap();
    assert_eq!(f.deliveries.load(Ordering::SeqCst), 2);
    saved.fail.store(true, Ordering::SeqCst);
    assert!(stream.next().await.unwrap().is_err());
    drop(stream);
    ctx.runtime_session_id = Some(saved.last());
    assert!(
        collect(runtime.reconnect(ctx))
            .await
            .iter()
            .any(|e| e["type"] == "run.completed")
    );
    assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
    f.shutdown().await;
}
#[tokio::test]
async fn cancellation_after_reader_drop_uses_fresh_owner_context_and_revokes_the_private_worker() {
    let f = Fixture::new(Mode::Stall, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let ctx = context(saved.clone());
    let stream = runtime.start(ctx.clone(), "Wait".into(), vec![]);
    let reader = tokio::spawn(async move { collect(stream).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), f.script.began.notified())
        .await
        .unwrap();
    reader.abort();
    assert!(reader.await.unwrap_err().is_cancelled());
    NativeRuntime::new(f.options())
        .unwrap()
        .cancel(&ctx.run_id, Some(&saved.last()), Some(&ctx))
        .await
        .unwrap();
    assert!(f.store.load(&channel(&ctx)).await.unwrap().cancelled);
    f.shutdown().await;
}
#[tokio::test]
async fn legacy_and_foreign_cursors_and_malformed_approvals_cannot_start_work() {
    let f = Fixture::new(Mode::Finish, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    for cursor in [
        "legacy-eve-session".to_owned(),
        Cursor {
            conversation_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            previous_run_id: None,
            stream_index: 0,
            deadline_ms: chrono::Utc::now().timestamp_millis() + 60000,
            settled: None,
            conversation: None,
            pending_inputs: false,
            delivery_complete: false,
            admitted: false,
        }
        .encode(),
    ] {
        let saved = Arc::new(Saved::default());
        let mut ctx = context(saved.clone());
        ctx.runtime_session_id = Some(cursor);
        assert!(
            runtime
                .start(ctx, "Hello".into(), vec![])
                .next()
                .await
                .unwrap()
                .is_err()
        );
        assert!(saved.values.lock().unwrap().is_empty());
    }
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved);
    ctx.runtime_session_id = Some(
        Cursor {
            conversation_id: ctx.thread_id.parse().unwrap(),
            run_id: ctx.run_id.parse().unwrap(),
            previous_run_id: None,
            stream_index: 0,
            deadline_ms: ctx.deadline_ms,
            settled: None,
            conversation: None,
            pending_inputs: false,
            delivery_complete: false,
            admitted: false,
        }
        .encode(),
    );
    assert!(
        runtime
            .resume(
                ctx,
                vec![json!({"requestId":Uuid::new_v4(),"optionId":"anything"})]
            )
            .next()
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(f.script.models.load(Ordering::SeqCst), 0);
    assert_eq!(f.deliveries.load(Ordering::SeqCst), 0);
    f.shutdown().await;
}

#[tokio::test]
async fn superseded_response_receipts_do_not_replace_the_current_conversation_cursor() {
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, Response},
    };
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved.clone());
    let head = Uuid::new_v4();
    let proof = forge_server::native_runtime::Conversation {
        id: ctx.thread_id.parse().unwrap(),
        head_run_id: head,
        generation: 7,
        owner_run_id: head,
        owner_next_index: 42,
        owner_deadline: ctx.deadline_ms,
    };
    let cursor = Cursor {
        conversation_id: proof.id,
        run_id: head,
        previous_run_id: None,
        stream_index: 42,
        deadline_ms: ctx.deadline_ms,
        admitted: true,
        settled: Some(forge_server::native_runtime::Settled::Complete),
        conversation: Some(proof.clone()),
        pending_inputs: false,
        delivery_complete: true,
    }
    .encode();
    saved.values.lock().unwrap().push(cursor.clone());
    ctx.runtime_session_id = Some(cursor.clone());
    let run = ctx.run_id.clone();
    let request_id = Uuid::new_v4();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let app = Router::new().fallback(move |request: Request<Body>| {
        let run = run.clone(); let proof = proof.clone(); let recorded = recorded.clone();
        async move {
            assert!(request.uri().path().ends_with("/resume"));
            let bytes = to_bytes(request.into_body(), 4096).await.unwrap();
            recorded.lock().unwrap().push(serde_json::from_slice::<Value>(&bytes).unwrap());
            Response::builder().status(202).header("content-type", "application/json")
                .body(Body::from(json!({"ok":true,"runId":run,"replayed":true,"currentDelivery":false,"streamStartIndex":3,"status":{"conversation":proof}}).to_string())).unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let runtime = NativeRuntime::new(forge_server::agent_runtime::Options {
        base_url: origin,
        channel_secret: SECRET.into(),
        capability_secret: SECRET.into(),
        model_secret: SECRET.into(),
        peer_origin: None,
        peer_identity: None,
        now: Arc::new(|| chrono::Utc::now().timestamp()),
    })
    .unwrap();
    assert!(
        collect(runtime.resume(
            ctx.clone(),
            vec![json!({"requestId":request_id,"optionId":"approve"})]
        ))
        .await
        .is_empty()
    );
    assert_eq!(*saved.values.lock().unwrap(), vec![cursor]);
    assert_eq!(
        *requests.lock().unwrap(),
        vec![
            json!({"requestId":request_id,"approved":true,"conversationId":ctx.thread_id,"expectedHeadRunId":head,"expectedGeneration":7})
        ]
    );
    server.abort();
}

#[tokio::test]
async fn definite_admission_conflicts_refresh_same_head_once_and_unknown_outcomes_keep_recovery() {
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, Response},
    };
    use std::sync::atomic::AtomicUsize;
    for case in ["refresh", "rejected", "unknown"] {
        let saved = Arc::new(Saved::default());
        let mut ctx = context(saved.clone());
        let old_head = Uuid::new_v4();
        let old = forge_server::native_runtime::Conversation {
            id: ctx.thread_id.parse().unwrap(),
            head_run_id: old_head,
            generation: 1,
            owner_run_id: old_head,
            owner_next_index: 4,
            owner_deadline: ctx.deadline_ms,
        };
        if case == "refresh" {
            ctx.runtime_session_id = Some(
                Cursor {
                    conversation_id: old.id,
                    run_id: old_head,
                    previous_run_id: None,
                    stream_index: 4,
                    deadline_ms: ctx.deadline_ms,
                    admitted: true,
                    settled: Some(forge_server::native_runtime::Settled::Complete),
                    conversation: Some(old.clone()),
                    pending_inputs: false,
                    delivery_complete: true,
                }
                .encode(),
            );
            saved
                .values
                .lock()
                .unwrap()
                .push(ctx.runtime_session_id.clone().unwrap());
        }
        let mut refreshed = old.clone();
        refreshed.generation = 2;
        let mut admitted = old;
        admitted.generation = 3;
        admitted.head_run_id = ctx.run_id.parse().unwrap();
        admitted.owner_run_id = admitted.head_run_id;
        admitted.owner_next_index = 0;
        let run = ctx.run_id.clone();
        let posts = Arc::new(AtomicUsize::new(0));
        let gets = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let seen_posts = posts.clone();
        let seen_gets = gets.clone();
        let seen_bodies = bodies.clone();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let run = run.clone(); let refreshed = refreshed.clone(); let admitted = admitted.clone();
            let posts = seen_posts.clone(); let gets = seen_gets.clone(); let bodies = seen_bodies.clone();
            async move {
                let path = request.uri().path().to_owned();
                if path.contains("/conversations/") {
                    gets.fetch_add(1, Ordering::SeqCst);
                    return Response::builder().header("content-type","application/json").body(Body::from(json!({"ok":true,"conversation":refreshed}).to_string())).unwrap();
                }
                let status = json!({"phase":"complete","cancelled":false,"nextIndex":0,"deliveryComplete":true,"pendingRequests":[],"conversation":admitted});
                if path.ends_with("/stream") {
                    return Response::builder().header("content-type","application/x-ndjson").body(Body::from(format!("{}\n",json!({"status":status})))).unwrap();
                }
                let bytes = to_bytes(request.into_body(), 4096).await.unwrap();
                bodies.lock().unwrap().push(serde_json::from_slice::<Value>(&bytes).unwrap());
                let index = posts.fetch_add(1, Ordering::SeqCst);
                if case == "refresh" && index == 0 {
                    return Response::builder().status(409).body(Body::empty()).unwrap();
                }
                if case == "rejected" || (case == "unknown" && index > 0) {
                    return Response::builder().status(400).body(Body::empty()).unwrap();
                }
                let body = if case == "unknown" { "{".to_owned() } else { json!({"ok":true,"runId":run,"status":status}).to_string() };
                Response::builder().status(202).header("content-type","application/json").body(Body::from(body)).unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let runtime = NativeRuntime::new(forge_server::agent_runtime::Options {
            base_url: origin,
            channel_secret: SECRET.into(),
            capability_secret: SECRET.into(),
            model_secret: SECRET.into(),
            peer_origin: None,
            peer_identity: None,
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        })
        .unwrap();
        let events = runtime
            .start(ctx, "Keep marigold".into(), vec![])
            .collect::<Vec<_>>()
            .await;
        if case == "refresh" {
            assert_eq!(
                events.last().unwrap().as_ref().unwrap()["type"],
                "run.completed"
            );
            assert_eq!(gets.load(Ordering::SeqCst), 1);
            assert_eq!(posts.load(Ordering::SeqCst), 2);
            let bodies = bodies.lock().unwrap();
            assert_eq!(bodies[0]["expectedGeneration"], 1);
            let mut expected = bodies[0].clone();
            expected["expectedGeneration"] = json!(2);
            assert_eq!(bodies[1], expected);
            assert_eq!(
                Cursor::decode(&saved.last())
                    .unwrap()
                    .conversation
                    .unwrap()
                    .generation,
                3
            );
        } else {
            assert!(events.iter().any(Result::is_err));
            assert_eq!(gets.load(Ordering::SeqCst), 0);
            if case == "rejected" {
                assert!(saved.values.lock().unwrap().is_empty());
                assert_eq!(posts.load(Ordering::SeqCst), 1);
            } else {
                assert!(!Cursor::decode(&saved.last()).unwrap().admitted);
                assert_eq!(posts.load(Ordering::SeqCst), 2);
                let bodies = bodies.lock().unwrap();
                assert_eq!(bodies[0], bodies[1]);
            }
        }
        server.abort();
    }
}

#[tokio::test]
async fn native_frames_reject_gaps_foreign_turns_truncation_invalid_utf8_and_wrong_media_types() {
    use axum::{
        Router,
        body::Body,
        http::{Request, Response},
    };
    use std::time::Duration;
    for case in 0..7 {
        let saved = Arc::new(Saved::default());
        let ctx = context(saved.clone());
        let wire = match case {
            0 => format!(
                "{}\n",
                json!({"index":1,"event":{"type":"turn.started","data":{"turnId":ctx.run_id}}})
            )
            .into_bytes(),
            1 => format!(
                "{}\n",
                json!({"index":0,"event":{"type":"turn.started","data":{"turnId":Uuid::new_v4()}}})
            )
            .into_bytes(),
            2 => format!(
                "{}\n",
                json!({"index":0,"event":{"type":"turn.started","data":{"turnId":ctx.run_id}}})
            )
            .into_bytes(), // valid event, missing terminal frame
            3 => vec![0xff, b'\n'],
            4 => b"{\"status\":{\"phase\":\"complete\",\"nextIndex\":0}}".to_vec(), // missing line boundary
            5 => b"{}\n".to_vec(),
            _ => vec![b' '; 8 * 1024 * 1024 + 2048],
        };
        let run = ctx.run_id.clone();
        let wire = Arc::new(wire);
        let app = Router::new().fallback(move |request: Request<Body>| {
            let run = run.clone();
            let wire = wire.clone();
            async move {
                if request.uri().path().ends_with("/stream") {
                    Response::builder()
                        .header(
                            "content-type",
                            if case == 5 {
                                "application/json"
                            } else {
                                "application/x-ndjson"
                            },
                        )
                        .body(Body::from(wire.as_ref().clone()))
                        .unwrap()
                } else {
                    Response::builder()
                        .status(202)
                        .header("content-type", "application/json")
                        .body(Body::from(json!({"ok":true,"runId":run}).to_string()))
                        .unwrap()
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let runtime = NativeRuntime::new(forge_server::agent_runtime::Options {
            base_url: origin,
            channel_secret: SECRET.into(),
            capability_secret: SECRET.into(),
            model_secret: SECRET.into(),
            peer_origin: None,
            peer_identity: None,
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        })
        .unwrap();
        let events = tokio::time::timeout(
            Duration::from_secs(5),
            runtime
                .start(ctx, "Hello".into(), vec![])
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        assert!(events.iter().any(Result::is_err), "case {case}");
        assert!(
            events
                .iter()
                .filter_map(|e| e.as_ref().err())
                .all(|error| !error.to_string().contains("public-fixture"))
        );
        server.abort();
    }
}

#[tokio::test]
async fn oversized_and_sensitive_tool_data_are_private_while_display_receipts_replay_safely() {
    for mode in [Mode::LargeToolData, Mode::SensitiveToolData] {
        let f = Fixture::new(mode, false).await;
        let runtime = NativeRuntime::new(f.options()).unwrap();
        let saved = Arc::new(Saved::default());
        let ctx = context(saved.clone());
        let events = collect(runtime.start(ctx.clone(), "Keep this task".into(), vec![])).await;
        assert_eq!(events.last().unwrap()["type"], "run.completed");
        for event in &events {
            assert!(forge_core::agents::contracts::safe_payload(&event["payload"]).is_ok());
        }
        let started = events.iter().find(|e| e["type"] == "tool.started").unwrap();
        let completed = events
            .iter()
            .find(|e| e["type"] == "tool.completed")
            .unwrap();
        assert_eq!(started["payload"]["displayDataOmitted"], true);
        assert_eq!(completed["payload"]["displayDataOmitted"], true);
        let expected = if matches!(mode, Mode::SensitiveToolData) {
            "Bearer fixture-credential-should-not-display".to_string()
        } else {
            "😀".repeat(40_000)
        };
        assert!(!serde_json::to_string(&events).unwrap().contains(&expected));
        let private = f.store.load(&channel(&ctx)).await.unwrap();
        assert_eq!(private.state.snapshot()["todos"][0]["content"], expected);
        let private_events = f.store.events(&channel(&ctx), 0, 64).await.unwrap();
        assert!(
            serde_json::to_string(&private_events.iter().map(|e| &e.value).collect::<Vec<_>>())
                .unwrap()
                .contains(&expected)
        );
        let mut replay = ctx.clone();
        let mut cursor = Cursor::decode(&saved.last()).unwrap();
        cursor.stream_index = 0;
        replay.runtime_session_id = Some(cursor.encode());
        let repeated = collect(runtime.reconnect(replay)).await;
        let repeated_tool = repeated
            .iter()
            .filter(|e| matches!(e["type"].as_str(), Some("tool.started" | "tool.completed")))
            .collect::<Vec<_>>();
        assert_eq!(repeated_tool, vec![started, completed]);
        f.shutdown().await;
    }
}

#[tokio::test]
async fn conversation_allowances_cross_turns_and_responses_never_grant_twice() {
    for approved in [true, false] {
        let f = Fixture::new(Mode::Budget, false).await;
        let runtime = NativeRuntime::new(f.options()).unwrap();
        let saved = Arc::new(Saved::default());
        let mut ctx = context(saved.clone());
        let events = collect(runtime.start(ctx.clone(), "First".into(), vec![])).await;
        assert!(events.iter().any(|e| e["type"] == "run.completed"));
        ctx.run_id = Uuid::new_v4().to_string();
        ctx.runtime_session_id = Some(saved.last());
        let events = collect(runtime.start(ctx.clone(), "Continue".into(), vec![])).await;
        let request = events
            .iter()
            .find(|e| e["type"] == "approval.requested")
            .unwrap()["payload"]["details"]["runtimeRequestId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
        let waiting = f.store.load(&channel(&ctx)).await.unwrap();
        assert_eq!(waiting.state.session_usage(), (10, 5));
        assert_eq!(waiting.state.usage(), (0, 0));
        ctx.runtime_session_id = Some(saved.last());
        let replay = collect(runtime.reconnect(ctx.clone())).await;
        assert!(replay.iter().any(|e| e["type"] == "run.waiting"));
        ctx.runtime_session_id = Some(saved.last());
        let response = json!({"requestId":request,"optionId":if approved{"approve"}else{"deny"}});
        let done = collect(runtime.resume(ctx.clone(), vec![response.clone()])).await;
        let terminal = if approved {
            "run.completed"
        } else {
            "run.cancelled"
        };
        assert!(done.iter().any(|e| e["type"] == terminal), "{done:?}");
        let state = f.store.load(&channel(&ctx)).await.unwrap().state;
        assert_eq!(
            state.session_usage(),
            if approved { (20, 10) } else { (10, 5) }
        );
        assert_eq!(state.usage(), if approved { (10, 5) } else { (0, 0) });
        ctx.runtime_session_id = Some(saved.last());
        let replay_events = collect(runtime.resume(ctx.clone(), vec![response])).await;
        assert!(replay_events.iter().any(|e| e["type"] == terminal));
        assert!(!replay_events.iter().any(|e| e["type"]
            == if approved {
                "run.cancelled"
            } else {
                "run.completed"
            }));
        let replay = f.store.load(&channel(&ctx)).await.unwrap().state;
        assert_eq!(state.snapshot(), replay.snapshot());
        assert_eq!(
            f.script.models.load(Ordering::SeqCst),
            if approved { 2 } else { 1 }
        );
        assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
        assert_eq!(
            *f.script.output_limits.lock().unwrap(),
            if approved {
                vec![50000, 50000]
            } else {
                vec![50000]
            }
        );
        ctx.runtime_session_id = Some(saved.last());
        ctx.run_id = Uuid::new_v4().to_string();
        let next = collect(runtime.start(ctx.clone(), "Another turn".into(), vec![])).await;
        let approval = next
            .iter()
            .find(|e| e["type"] == "approval.requested")
            .unwrap();
        assert_ne!(approval["payload"]["details"]["runtimeRequestId"], request);
        assert_eq!(
            approval["payload"]["input"]["usedTokens"],
            if approved { 20 } else { 10 }
        );
        assert_eq!(
            f.script.models.load(Ordering::SeqCst),
            if approved { 2 } else { 1 }
        );
        f.shutdown().await;
    }
}
#[tokio::test]
async fn native_provider_search_replays_readable_receipts_and_keeps_opaque_history_private() {
    let f = Fixture::new(Mode::Search, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut ctx = context(saved.clone());
    ctx.model["provider"] = json!("anthropic");
    let events = collect(runtime.start(ctx.clone(), "Search for the marker".into(), vec![])).await;
    assert!(events.iter().any(|e| e["type"] == "run.completed"));
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "tool.completed")
            .count(),
        1
    );
    let answer = events
        .iter()
        .find(|e| e["type"] == "assistant.message")
        .unwrap();
    assert_eq!(
        answer["payload"]["sources"],
        json!([{"url":"https://example.com/forge","title":"Forge reference"}])
    );
    assert!(
        !json!(events)
            .to_string()
            .contains("fixture-private-search-content")
    );
    let state = f.store.load(&channel(&ctx)).await.unwrap().state;
    assert!(
        json!(state.history())
            .to_string()
            .contains("fixture-private-search-content")
    );
    assert_eq!(f.script.models.load(Ordering::SeqCst), 2);
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    ctx.runtime_session_id = Some(saved.last());
    let replay = collect(runtime.reconnect(ctx.clone())).await;
    assert_eq!(f.script.models.load(Ordering::SeqCst), 2);
    assert!(replay.iter().any(|e| e["type"] == "run.completed"));
    ctx.runtime_session_id = Some(saved.last());
    ctx.run_id = Uuid::new_v4().to_string();
    ctx.model["provider"] = json!("openai");
    ctx.model["connectionId"] = json!(Uuid::new_v4());
    let next = collect(runtime.start(ctx.clone(), "Use those findings".into(), vec![])).await;
    assert!(next.iter().any(|e| e["type"] == "run.completed"));
    let state = f.store.load(&channel(&ctx)).await.unwrap().state;
    assert!(
        !json!(state.history())
            .to_string()
            .contains("fixture-private-search-content")
    );
    assert_eq!(f.script.models.load(Ordering::SeqCst), 3);
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    f.shutdown().await;
}
