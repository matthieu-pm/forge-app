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
    assert_eq!(
        state.history()[1]["content"][0]["text"],
        "Remember marigold"
    );
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 1);
    f.shutdown().await;
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
