use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, Response},
};
use forge_agent_runtime::auth::Channel;
use forge_core::agents::runtime::{
    Checkpoint, Context, ConversationFence, DeliveryFrame, DeliveryPhase, DeliveryReceipt,
    DeliverySnapshot, DrainBoundary, Error, HandoffAuthority, HandoffPlan, Identity, IntentReceipt,
    IntentState, OpenDelivery, Preparation, QueuedInput, Runtime,
};
use forge_server::{
    agent_runtime::Options,
    native_runtime::{Conversation, Cursor, NativeRuntime},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;

const SECRET: &str = "managed-transport-fixture-secret-with-enough-entropy";

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
            workspace_id: "managed-transport-workspace".into(),
            user_id: "managed-transport-user".into(),
            workspace_role: "owner".into(),
        },
        model: json!({"connectionId":Uuid::new_v4(),"provider":"openai","modelId":"fixture-model"}),
        reasoning_effort: "medium".into(),
        deadline_ms: chrono::Utc::now().timestamp_millis() + 60_000,
        runtime_session_id: None,
        correlation_id: None,
        checkpoint: saved,
    }
}
fn boundary(context: &Context, generation: u64) -> DrainBoundary {
    let run = context.run_id.parse().unwrap();
    let snapshot = DeliverySnapshot {
        run_id: run,
        input_generation: generation,
        state_revision: 3,
        next_index: 0,
        phase: DeliveryPhase::Complete,
        cancelled: false,
        delivery_only: false,
    };
    DrainBoundary {
        conversation: ConversationFence {
            conversation_id: context.thread_id.parse().unwrap(),
            head_run_id: run,
            generation,
        },
        delivery: snapshot.clone(),
        execution: snapshot,
    }
}
fn proof(context: &Context, boundary: &DrainBoundary) -> Conversation {
    Conversation {
        id: boundary.conversation.conversation_id,
        head_run_id: boundary.conversation.head_run_id,
        generation: boundary.conversation.generation,
        owner_run_id: boundary.execution.run_id,
        owner_next_index: boundary.execution.next_index,
        owner_deadline: context.deadline_ms,
    }
}
fn status(context: &Context, boundary: &DrainBoundary) -> Value {
    json!({
        "phase":boundary.delivery.phase,"cancelled":boundary.delivery.cancelled,
        "nextIndex":boundary.delivery.next_index,"deadline":context.deadline_ms,
        "pendingRequests":[],"pendingRequestId":null,"deliveryComplete":true,
        "conversation":proof(context,boundary),"boundary":boundary
    })
}
fn receipt(context: &Context, generation: u64) -> DeliveryReceipt {
    DeliveryReceipt {
        run_id: context.run_id.parse().unwrap(),
        input_generation: generation,
        stream_start_index: 0,
        current_delivery: true,
        replayed: true,
        handoff_id: None,
    }
}
fn acknowledged(context: &Context, boundary: &DrainBoundary) -> Value {
    json!({"ok":true,"runId":context.run_id,"delivery":receipt(context,boundary.delivery.input_generation),"status":status(context,boundary)})
}
fn seed(context: &mut Context, saved: &Saved, boundary: &DrainBoundary) {
    let cursor = Cursor {
        conversation_id: boundary.conversation.conversation_id,
        run_id: context.run_id.parse().unwrap(),
        previous_run_id: None,
        stream_index: 0,
        deadline_ms: context.deadline_ms,
        admitted: true,
        settled: None,
        conversation: Some(proof(context, boundary)),
        pending_inputs: false,
        delivery_complete: false,
    }
    .encode();
    saved.values.lock().unwrap().push(cursor.clone());
    context.runtime_session_id = Some(cursor);
}
struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}
impl Reply {
    fn json(value: Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: value.to_string(),
        }
    }
    fn stream(frames: Vec<Value>) -> Self {
        Self {
            status: 200,
            content_type: "application/x-ndjson",
            body: frames
                .into_iter()
                .map(|frame| format!("{frame}\n"))
                .collect(),
        }
    }
}
struct Seen {
    method: Method,
    path: String,
    run: String,
    body: Value,
}
struct Fake {
    runtime: NativeRuntime,
    requests: Arc<Mutex<Vec<Seen>>>,
    remaining: Arc<Mutex<VecDeque<Reply>>>,
    server: tokio::task::JoinHandle<()>,
}
impl Fake {
    async fn new(replies: Vec<Reply>) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let remaining = Arc::new(Mutex::new(VecDeque::from(replies)));
        let seen = requests.clone();
        let queue = remaining.clone();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let seen = seen.clone();
            let queue = queue.clone();
            async move {
                let channel = Channel::verify(
                    SECRET,
                    request.headers()["authorization"].to_str().unwrap(),
                    chrono::Utc::now().timestamp(),
                )
                .unwrap();
                let method = request.method().clone();
                let path = request.uri().to_string();
                let body = to_bytes(request.into_body(), 16_384).await.unwrap();
                seen.lock().unwrap().push(Seen {
                    method,
                    path,
                    run: channel.run_id().to_owned(),
                    body: if body.is_empty() {
                        Value::Null
                    } else {
                        serde_json::from_slice(&body).unwrap()
                    },
                });
                let reply = queue
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("Unexpected native request");
                Response::builder()
                    .status(reply.status)
                    .header("content-type", reply.content_type)
                    .body(Body::from(reply.body))
                    .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let runtime = NativeRuntime::new(Options {
            base_url: origin,
            channel_secret: SECRET.into(),
            capability_secret: SECRET.into(),
            model_secret: SECRET.into(),
            peer_origin: None,
            peer_identity: None,
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        })
        .unwrap();
        Self {
            runtime,
            requests,
            remaining,
            server,
        }
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn cancelled_generating_delivery_yields_raw_event_then_receipt_then_uncommitted_boundary() {
    let saved = Arc::new(Saved::default());
    let mut context = context(saved.clone());
    // Completed private work remains drainable after execution's deadline.
    context.deadline_ms -= 120_000;
    let mut boundary = boundary(&context, 4);
    boundary.delivery.phase = DeliveryPhase::Generating;
    boundary.delivery.cancelled = true;
    boundary.delivery.next_index = 1;
    boundary.execution = boundary.delivery.clone();
    seed(&mut context, &saved, &boundary);
    let f = Fake::new(vec![
        Reply::json(acknowledged(&context, &boundary)),
        Reply::stream(vec![
            json!({"index":0,"event":{"type":"turn.cancelled","data":{"turnId":context.run_id}}}),
            json!({"status":status(&context,&boundary)}),
        ]),
    ])
    .await;
    let mut session = f
        .runtime
        .open_delivery(
            context.clone(),
            OpenDelivery::Recover {
                input_generation: 4,
            },
        )
        .await
        .unwrap();
    assert!(f.runtime.supports_delivery_queue());
    for expected_source in [
        format!("native:{}:turn.cancelled:stream-0", context.run_id),
        format!("native:{}:delivery:4:status:run.cancelled", context.run_id),
    ] {
        let DeliveryFrame::Event(event) = session.frames.next().await.unwrap().unwrap() else {
            panic!("Expected cancellation event")
        };
        assert_eq!(event["type"], "run.cancelled");
        assert_eq!(event["sourceEventId"], expected_source);
        assert!(!Cursor::decode(&saved.last()).unwrap().delivery_complete);
    }
    let DeliveryFrame::Parked {
        boundary: drained,
        final_cursor,
    } = session.frames.next().await.unwrap().unwrap()
    else {
        panic!("Expected boundary")
    };
    assert_eq!(drained, boundary);
    assert_eq!(Cursor::decode(&saved.last()).unwrap().stream_index, 1);
    assert!(!Cursor::decode(&saved.last()).unwrap().delivery_complete);
    assert!(Cursor::decode(&final_cursor).unwrap().delivery_complete);
    assert!(session.frames.next().await.is_none());
    let requests = f.requests.lock().unwrap();
    assert_eq!(requests[0].method, Method::POST);
    assert_eq!(
        requests[0].body,
        json!({"managed":true,"inputGeneration":4})
    );
    assert_eq!(
        requests[1].path,
        format!(
            "/native/v1/runs/{}/stream?after=0&inputGeneration=4",
            context.run_id
        )
    );
    assert!(f.remaining.lock().unwrap().is_empty());
}

#[tokio::test]
async fn deferred_delivery_boundary_keeps_execution_owner_and_controls_leave_live_feed_untouched() {
    let saved = Arc::new(Saved::default());
    let context = context(saved.clone());
    let mut boundary = boundary(&context, 0);
    boundary.conversation.generation = 3;
    boundary.delivery.delivery_only = true;
    boundary.execution.run_id = Uuid::new_v4();
    boundary.execution.input_generation = 1;
    boundary.execution.phase = DeliveryPhase::Waiting;
    let input = QueuedInput {
        intent_id: Uuid::new_v4(),
        conversation_id: boundary.conversation.conversation_id,
        request_id: Uuid::new_v4(),
        approved: true,
    };
    let mut original = context.clone();
    original.run_id = boundary.execution.run_id.to_string();
    let intent = IntentReceipt {
        intent_id: input.intent_id,
        sequence: 1,
        original_run_id: boundary.execution.run_id,
        request_id: input.request_id,
        approved: true,
        state: IntentState::Queued,
        handoff_id: None,
        activation_run_id: None,
        stream_start_index: None,
        replayed: false,
        conversation: boundary.conversation.clone(),
    };
    let plan = HandoffPlan {
        id: Uuid::new_v4(),
        conversation: boundary.conversation.clone(),
        anchor_intent_id: input.intent_id,
        intent_ids: vec![input.intent_id],
        prefix_end_sequence: 1,
        activation_run_id: boundary.execution.run_id,
        authority: HandoffAuthority {
            provider: "openai".into(),
            model_id: "fixture-model".into(),
            reasoning_effort: "medium".into(),
        },
        boundary: boundary.clone(),
    };
    let f = Fake::new(vec![
        Reply::json(acknowledged(&context,&boundary)), Reply::stream(vec![json!({"status":status(&context,&boundary)})]),
        Reply::json(json!({"ok":true,"runId":original.run_id,"intent":intent})),
        Reply::json(json!({"ok":true,"runId":context.run_id,"preparation":Preparation::Ready{plan:plan.clone()}})),
        Reply::json(json!({"ok":true,"runId":context.run_id})),
    ]).await;
    let mut session = f
        .runtime
        .open_delivery(
            context.clone(),
            OpenDelivery::Start {
                message: "Queued follow-up".into(),
                attachments: vec![],
            },
        )
        .await
        .unwrap();
    let before = saved.values.lock().unwrap().clone();
    assert_eq!(
        f.runtime.enqueue_input(&original, &input).await.unwrap(),
        intent
    );
    assert_eq!(
        f.runtime
            .prepare_handoff(&context, &boundary.conversation)
            .await
            .unwrap(),
        Preparation::Ready { plan }
    );
    assert_eq!(*saved.values.lock().unwrap(), before);
    let DeliveryFrame::Event(event) = session.frames.next().await.unwrap().unwrap() else {
        panic!("Expected completion")
    };
    assert_eq!(event["type"], "run.completed");
    let DeliveryFrame::Parked {
        boundary: drained,
        final_cursor,
    } = session.frames.next().await.unwrap().unwrap()
    else {
        panic!("Expected boundary")
    };
    assert_eq!(drained, boundary);
    assert_eq!(*saved.values.lock().unwrap(), before);
    saved.save(final_cursor).await.unwrap();
    let committed = saved.values.lock().unwrap().clone();
    f.runtime
        .acknowledge_drained(&context, &drained)
        .await
        .unwrap();
    assert_eq!(*saved.values.lock().unwrap(), committed);
    assert!(session.frames.next().await.is_none());
    let requests = f.requests.lock().unwrap();
    assert_eq!(requests[0].body["managed"], true);
    assert_eq!(requests[2].run, original.run_id);
    assert_eq!(requests[2].body, json!(input));
    assert_eq!(requests[3].body, json!({"fence":boundary.conversation}));
    assert_eq!(requests[4].body, json!({"boundary":boundary}));
}

#[tokio::test]
async fn rejected_recovery_never_steals_the_accepted_delivery_owner() {
    for case in [
        "rejected",
        "foreign-run",
        "foreign-boundary",
        "unsafe-index",
        "wrong-generation",
        "checkpoint",
        "superseded",
    ] {
        let saved = Arc::new(Saved::default());
        let mut context = context(saved.clone());
        let boundary = boundary(&context, 7);
        seed(&mut context, &saved, &boundary);
        let mut second = acknowledged(&context, &boundary);
        match case {
            "foreign-run" => second["delivery"]["runId"] = json!(Uuid::new_v4()),
            "foreign-boundary" => {
                second["status"]["boundary"]["execution"]["runId"] = json!(Uuid::new_v4())
            }
            "unsafe-index" => {
                second["delivery"]["streamStartIndex"] = json!(9_007_199_254_740_992u64)
            }
            "wrong-generation" => second["delivery"]["inputGeneration"] = json!(8),
            "superseded" => second["delivery"]["currentDelivery"] = json!(false),
            _ => {}
        }
        let mut rejection = Reply::json(second);
        if case == "rejected" {
            rejection.status = 409;
        }
        let f = Fake::new(vec![
            Reply::json(acknowledged(&context, &boundary)),
            Reply::stream(vec![json!({"status":status(&context,&boundary)})]),
            rejection,
        ])
        .await;
        let mut current = f
            .runtime
            .open_delivery(
                context.clone(),
                OpenDelivery::Recover {
                    input_generation: 7,
                },
            )
            .await
            .unwrap();
        let before = saved.values.lock().unwrap().clone();
        saved.fail.store(case == "checkpoint", Ordering::SeqCst);
        let recovered = f
            .runtime
            .open_delivery(
                context.clone(),
                OpenDelivery::Recover {
                    input_generation: 7,
                },
            )
            .await;
        if case == "superseded" {
            let mut recovered = recovered.unwrap();
            assert!(!recovered.admission.current_delivery);
            assert!(recovered.frames.next().await.is_none());
        } else {
            assert!(recovered.is_err(), "{case}");
        }
        assert_eq!(*saved.values.lock().unwrap(), before, "{case}");
        assert!(matches!(
            current.frames.next().await.unwrap().unwrap(),
            DeliveryFrame::Event(_)
        ));
        assert!(matches!(
            current.frames.next().await.unwrap().unwrap(),
            DeliveryFrame::Parked { .. }
        ));
        assert!(current.frames.next().await.is_none());
        assert!(f.remaining.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn final_boundary_must_match_the_accepted_generation_and_consumed_offset() {
    for case in ["generation", "offset", "owner", "cancelled"] {
        let saved = Arc::new(Saved::default());
        let mut context = context(saved.clone());
        let boundary = boundary(&context, 2);
        seed(&mut context, &saved, &boundary);
        let mut terminal = status(&context, &boundary);
        match case {
            "generation" => terminal["boundary"]["delivery"]["inputGeneration"] = json!(3),
            "offset" => terminal["boundary"]["delivery"]["nextIndex"] = json!(1),
            "owner" => terminal["boundary"]["execution"]["runId"] = json!(Uuid::new_v4()),
            "cancelled" => terminal["boundary"]["delivery"]["cancelled"] = json!(true),
            _ => unreachable!(),
        }
        let f = Fake::new(vec![
            Reply::json(acknowledged(&context, &boundary)),
            Reply::stream(vec![json!({"status":terminal})]),
        ])
        .await;
        let mut session = f
            .runtime
            .open_delivery(
                context,
                OpenDelivery::Recover {
                    input_generation: 2,
                },
            )
            .await
            .unwrap();
        assert!(session.frames.next().await.unwrap().is_err(), "{case}");
        assert!(!Cursor::decode(&saved.last()).unwrap().delivery_complete);
        assert!(session.frames.next().await.is_none());
    }
}
