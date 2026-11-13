#[path = "support/native_runtime.rs"]
#[allow(dead_code)] // Reuse the real HTTP/worker fixture without every model mode.
mod support;

use async_trait::async_trait;
use forge_agent_runtime::auth::Channel;
use forge_core::agents::{
    runtime::{
        Checkpoint, Context, DeliveryFrame, DeliveryReceipt, DrainBoundary, Error, HandoffPlan,
        Identity, IntentState, ManagedSession, OpenDelivery, Preparation, QueuedInput, Runtime,
    },
    tokens::{Kind, mint},
};
use forge_server::native_runtime::{Cursor, NativeRuntime};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, atomic::Ordering};
use support::{Fixture, Mode, SECRET};
use uuid::Uuid;

#[derive(Default)]
struct Saved(Mutex<Vec<String>>);
impl Saved {
    fn last(&self) -> String {
        self.0.lock().unwrap().last().unwrap().clone()
    }
}
#[async_trait]
impl Checkpoint for Saved {
    async fn save(&self, cursor: String) -> Result<(), Error> {
        assert!(Cursor::decode(&cursor).is_some());
        self.0.lock().unwrap().push(cursor);
        Ok(())
    }
    async fn clear(&self) -> Result<(), Error> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}
fn context(saved: Arc<Saved>) -> Context {
    Context {
        thread_id: Uuid::new_v4().to_string(),
        run_id: Uuid::new_v4().to_string(),
        identity: Identity {
            workspace_id: "managed-fixture-workspace".into(),
            user_id: "managed-fixture-user".into(),
            workspace_role: "owner".into(),
        },
        model: json!({"connectionId":Uuid::new_v4(),"provider":"openai","modelId":"fixture-model"}),
        reasoning_effort: "medium".into(),
        deadline_ms: chrono::Utc::now().timestamp_millis() + 120_000,
        runtime_session_id: None,
        correlation_id: None,
        checkpoint: saved,
    }
}
fn channel(context: &Context) -> Channel {
    let now = chrono::Utc::now().timestamp();
    let token = mint(SECRET, Kind::RuntimeChannel, json!({
        "sub":context.identity.user_id,"workspaceId":context.identity.workspace_id,
        "runId":context.run_id,"forgeCapabilityToken":"managed-fixture-capability",
        "forgeModelAccessToken":"managed-fixture-model-access","provider":context.model["provider"],
        "modelId":context.model["modelId"],"reasoningEffort":context.reasoning_effort
    }), now, 900.).unwrap();
    Channel::verify(SECRET, &format!("Bearer {token}"), now).unwrap()
}
struct Drained {
    admission: DeliveryReceipt,
    events: Vec<Value>,
    boundary: DrainBoundary,
}
async fn drain(mut session: ManagedSession, saved: &Saved) -> Drained {
    let mut events = vec![];
    while let Some(frame) = session.frames.next().await {
        match frame.unwrap() {
            DeliveryFrame::Event(event) => events.push(event),
            DeliveryFrame::Parked {
                boundary,
                final_cursor,
            } => {
                // The application owns this final commit. Consuming the stream
                // does not itself acknowledge durable application persistence.
                saved.save(final_cursor).await.unwrap();
                assert!(session.frames.next().await.is_none());
                return Drained {
                    admission: session.admission,
                    events,
                    boundary,
                };
            }
        }
    }
    panic!("Managed delivery ended without a certified drain boundary");
}
fn approvals(events: &[Value]) -> Vec<Uuid> {
    events
        .iter()
        .filter(|e| e["type"] == "approval.requested")
        .map(|e| {
            e["payload"]["details"]["runtimeRequestId"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect()
}
fn input(context: &Context, request: Uuid, approved: bool) -> QueuedInput {
    QueuedInput {
        intent_id: Uuid::new_v4(),
        conversation_id: context.thread_id.parse().unwrap(),
        request_id: request,
        approved,
    }
}
fn ready(preparation: Preparation) -> HandoffPlan {
    match preparation {
        Preparation::Ready { plan } => plan,
        other => panic!("Expected a prepared handoff, got {other:?}"),
    }
}
fn terminal_id(events: &[Value]) -> &str {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "run.completed")
        .unwrap()["sourceEventId"]
        .as_str()
        .unwrap()
}

fn waiting_id(events: &[Value]) -> &str {
    events
        .iter()
        .rev()
        .find(|event| event["type"] == "run.waiting")
        .unwrap()["sourceEventId"]
        .as_str()
        .unwrap()
}

#[tokio::test]
async fn queued_older_approvals_wait_for_drain_and_keep_active_authority_and_history() {
    let f = Fixture::new(Mode::MixedRequired, true).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    assert!(runtime.supports_delivery_queue());
    let saved = Arc::new(Saved::default());
    let mut a = context(saved.clone());
    let initial = drain(
        runtime
            .open_delivery(
                a.clone(),
                OpenDelivery::Start {
                    message: "Remember marigold and make two changes".into(),
                    attachments: vec![],
                },
            )
            .await
            .unwrap(),
        &saved,
    )
    .await;
    let requests = approvals(&initial.events);
    assert_eq!(requests.len(), 2);
    runtime
        .acknowledge_drained(&a, &initial.boundary)
        .await
        .unwrap();
    a.runtime_session_id = Some(saved.last());
    let mut b = a.clone();
    b.run_id = Uuid::new_v4().to_string();
    b.model["provider"] = json!("anthropic");
    b.model["connectionId"] = json!(Uuid::new_v4());
    f.script.pause_next_model.store(true, Ordering::SeqCst);
    let active = runtime
        .open_delivery(
            b.clone(),
            OpenDelivery::Start {
                message: "yes".into(),
                attachments: vec![],
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        f.script.model_paused.notified(),
    )
    .await
    .unwrap();
    let before = f.store.load(&channel(&b)).await.unwrap();
    let checkpoint_before = saved.last();
    let first = input(&a, requests[0], true);
    let second = input(&a, requests[1], false);
    let receipt = runtime.enqueue_input(&a, &first).await.unwrap();
    let later = runtime.enqueue_input(&a, &second).await.unwrap();
    assert_eq!(receipt.state, IntentState::Queued);
    assert_eq!(later.sequence, receipt.sequence + 1);
    let duplicate = runtime.enqueue_input(&a, &first).await.unwrap();
    assert!(duplicate.replayed);
    assert_eq!(duplicate.sequence, receipt.sequence);
    let mut conflict = first.clone();
    conflict.approved = false;
    assert!(runtime.enqueue_input(&a, &conflict).await.is_err());
    assert_eq!(saved.last(), checkpoint_before);
    let after = f.store.load(&channel(&b)).await.unwrap();
    assert_eq!(after.state.snapshot(), before.state.snapshot());
    assert_eq!(after.next_index, before.next_index);
    assert_eq!(after.boundary, before.boundary);
    assert!(after.worker_active);
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    assert_eq!(
        *f.script.callback_runs.lock().unwrap(),
        vec![b.run_id.clone(), b.run_id.clone()]
    );
    assert_eq!(
        f.script.model_runs.lock().unwrap().last().unwrap(),
        &(b.run_id.clone(), "anthropic".into())
    );
    assert_eq!(
        runtime
            .prepare_handoff(&b, &receipt.conversation)
            .await
            .unwrap(),
        Preparation::AwaitingDrain
    );

    f.script.release_model.notify_one();
    let completed = drain(active, &saved).await;
    assert_eq!(completed.boundary.delivery.run_id.to_string(), b.run_id);
    assert_eq!(
        runtime
            .prepare_handoff(&b, &completed.boundary.conversation)
            .await
            .unwrap(),
        Preparation::AwaitingDrain
    );
    let mut incorrect = completed.boundary.clone();
    incorrect.delivery.next_index += 1;
    assert!(runtime.acknowledge_drained(&b, &incorrect).await.is_err());
    runtime
        .acknowledge_drained(&b, &completed.boundary)
        .await
        .unwrap();
    runtime
        .acknowledge_drained(&b, &completed.boundary)
        .await
        .unwrap();
    let plan = ready(
        runtime
            .prepare_handoff(&b, &completed.boundary.conversation)
            .await
            .unwrap(),
    );
    assert_eq!(plan.anchor_intent_id, first.intent_id);
    assert_eq!(plan.intent_ids, vec![first.intent_id, second.intent_id]);
    assert_eq!(plan.activation_run_id.to_string(), a.run_id);
    assert_eq!(plan.authority.provider, "openai");
    assert_eq!(
        ready(
            runtime
                .prepare_handoff(&b, &completed.boundary.conversation)
                .await
                .unwrap()
        ),
        plan
    );
    assert!(
        runtime
            .open_delivery(b.clone(), OpenDelivery::Activate { plan: plan.clone() })
            .await
            .is_err()
    );
    a.runtime_session_id = Some(saved.last());
    let resumed = drain(
        runtime
            .open_delivery(a.clone(), OpenDelivery::Activate { plan: plan.clone() })
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert_eq!(resumed.admission.handoff_id, Some(plan.id));
    assert!(resumed.admission.current_delivery);
    assert_eq!(resumed.boundary.execution.run_id.to_string(), a.run_id);
    assert_eq!(
        resumed.boundary.conversation.head_run_id.to_string(),
        b.run_id
    );
    assert_eq!(
        f.script.model_runs.lock().unwrap().last().unwrap(),
        &(a.run_id.clone(), "openai".into())
    );
    {
        let prompts = f.script.model_prompts.lock().unwrap();
        let prompt = &prompts.last().unwrap().1;
        assert!(prompt.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"]
                    .to_string()
                    .contains("The marker is marigold.")
        }));
    }
    // B's already denied calls cannot become new effects when stale approvals
    // later return to A; the complete latest history is still carried forward.
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    let models = f.script.models.load(Ordering::SeqCst);
    let replayed = drain(
        runtime
            .open_delivery(a.clone(), OpenDelivery::Activate { plan: plan.clone() })
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert!(replayed.admission.replayed);
    assert_eq!(terminal_id(&resumed.events), terminal_id(&replayed.events));
    assert_eq!(f.script.models.load(Ordering::SeqCst), models);
    assert_eq!(replayed.boundary, resumed.boundary);
    runtime
        .acknowledge_drained(&a, &replayed.boundary)
        .await
        .unwrap();
    assert_eq!(
        runtime
            .prepare_handoff(&a, &replayed.boundary.conversation)
            .await
            .unwrap(),
        Preparation::Empty
    );
    f.shutdown().await;
}

#[tokio::test]
async fn prepared_prefix_is_immutable_and_later_same_run_input_uses_a_distinct_delivery() {
    let f = Fixture::new(Mode::MixedRequired, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut a = context(saved.clone());
    let initial = drain(
        runtime
            .open_delivery(
                a.clone(),
                OpenDelivery::Start {
                    message: "Remember marigold and make two changes".into(),
                    attachments: vec![],
                },
            )
            .await
            .unwrap(),
        &saved,
    )
    .await;
    let requests = approvals(&initial.events);
    runtime
        .acknowledge_drained(&a, &initial.boundary)
        .await
        .unwrap();
    a.runtime_session_id = Some(saved.last());
    let mut b = a.clone();
    b.run_id = Uuid::new_v4().to_string();
    let deferred = drain(
        runtime
            .open_delivery(
                b.clone(),
                OpenDelivery::Start {
                    message: "Please keep the changes queued".into(),
                    attachments: vec![],
                },
            )
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert!(deferred.boundary.delivery.delivery_only);
    assert_eq!(deferred.boundary.delivery.run_id.to_string(), b.run_id);
    assert_eq!(deferred.boundary.execution.run_id.to_string(), a.run_id);
    runtime
        .acknowledge_drained(&b, &deferred.boundary)
        .await
        .unwrap();
    let first = input(&a, requests[0], true);
    let second = input(&a, requests[1], false);
    runtime.enqueue_input(&a, &first).await.unwrap();
    let first_plan = ready(
        runtime
            .prepare_handoff(&b, &deferred.boundary.conversation)
            .await
            .unwrap(),
    );
    runtime.enqueue_input(&a, &second).await.unwrap();
    assert_eq!(first_plan.intent_ids, vec![first.intent_id]);
    assert_eq!(
        ready(
            runtime
                .prepare_handoff(&b, &deferred.boundary.conversation)
                .await
                .unwrap()
        ),
        first_plan
    );
    a.runtime_session_id = Some(saved.last());
    let first_delivery = drain(
        runtime
            .open_delivery(
                a.clone(),
                OpenDelivery::Activate {
                    plan: first_plan.clone(),
                },
            )
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
    a.runtime_session_id = Some(saved.last());
    let partial_replay = drain(
        runtime
            .open_delivery(a.clone(), OpenDelivery::Activate { plan: first_plan })
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert_eq!(
        waiting_id(&first_delivery.events),
        waiting_id(&partial_replay.events)
    );
    assert_eq!(first_delivery.boundary, partial_replay.boundary);
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    assert_eq!(f.script.models.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime
            .prepare_handoff(&a, &first_delivery.boundary.conversation)
            .await
            .unwrap(),
        Preparation::AwaitingDrain
    );
    runtime
        .acknowledge_drained(&a, &first_delivery.boundary)
        .await
        .unwrap();
    let second_plan = ready(
        runtime
            .prepare_handoff(&a, &first_delivery.boundary.conversation)
            .await
            .unwrap(),
    );
    assert_eq!(second_plan.intent_ids, vec![second.intent_id]);
    assert_eq!(second_plan.activation_run_id.to_string(), a.run_id);
    a.runtime_session_id = Some(saved.last());
    let second_delivery = drain(
        runtime
            .open_delivery(a.clone(), OpenDelivery::Activate { plan: second_plan })
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert!(second_delivery.admission.input_generation > first_delivery.admission.input_generation);
    assert_ne!(
        waiting_id(&first_delivery.events),
        terminal_id(&second_delivery.events)
    );
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 1);
    assert_eq!(
        *f.script.callback_runs.lock().unwrap(),
        vec![a.run_id.clone()]
    );
    assert_eq!(f.script.models.load(Ordering::SeqCst), 2);
    assert_eq!(
        second_delivery.boundary.execution.run_id.to_string(),
        a.run_id
    );
    runtime
        .acknowledge_drained(&a, &second_delivery.boundary)
        .await
        .unwrap();
    f.shutdown().await;
}

#[tokio::test]
async fn cancelled_successor_is_fully_drained_before_an_older_queued_reply_resumes() {
    let f = Fixture::new(Mode::MixedRequired, false).await;
    let runtime = NativeRuntime::new(f.options()).unwrap();
    let saved = Arc::new(Saved::default());
    let mut a = context(saved.clone());
    let initial = drain(
        runtime
            .open_delivery(
                a.clone(),
                OpenDelivery::Start {
                    message: "Remember marigold and make two changes".into(),
                    attachments: vec![],
                },
            )
            .await
            .unwrap(),
        &saved,
    )
    .await;
    let requests = approvals(&initial.events);
    runtime
        .acknowledge_drained(&a, &initial.boundary)
        .await
        .unwrap();
    a.runtime_session_id = Some(saved.last());
    let mut b = a.clone();
    b.run_id = Uuid::new_v4().to_string();
    b.model["provider"] = json!("anthropic");
    f.script.pause_next_model.store(true, Ordering::SeqCst);
    let active = runtime
        .open_delivery(
            b.clone(),
            OpenDelivery::Start {
                message: "yes".into(),
                attachments: vec![],
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        f.script.model_paused.notified(),
    )
    .await
    .unwrap();
    let first = input(&a, requests[0], true);
    let second = input(&a, requests[1], true);
    runtime.enqueue_input(&a, &first).await.unwrap();
    runtime.enqueue_input(&a, &second).await.unwrap();
    // Cancel at the private service, leaving the app stream alive to consume
    // both the terminal public event and its later certified drain boundary.
    assert!(f.store.cancel(&channel(&b)).await.unwrap());
    f.host.stop(&b.run_id);
    let cancelled = drain(active, &saved).await;
    assert!(cancelled.boundary.delivery.cancelled);
    assert!(
        cancelled
            .events
            .iter()
            .any(|event| event["type"] == "run.cancelled")
    );
    assert_eq!(
        runtime
            .prepare_handoff(&b, &cancelled.boundary.conversation)
            .await
            .unwrap(),
        Preparation::AwaitingDrain
    );
    runtime
        .acknowledge_drained(&b, &cancelled.boundary)
        .await
        .unwrap();
    let plan = ready(
        runtime
            .prepare_handoff(&b, &cancelled.boundary.conversation)
            .await
            .unwrap(),
    );
    assert_eq!(plan.intent_ids, vec![first.intent_id, second.intent_id]);
    assert_eq!(plan.activation_run_id.to_string(), a.run_id);
    a.runtime_session_id = Some(saved.last());
    let resumed = drain(
        runtime
            .open_delivery(a.clone(), OpenDelivery::Activate { plan })
            .await
            .unwrap(),
        &saved,
    )
    .await;
    assert!(!resumed.boundary.delivery.cancelled);
    assert_eq!(resumed.boundary.execution.run_id.to_string(), a.run_id);
    assert_eq!(f.script.effects.load(Ordering::SeqCst), 0);
    assert_eq!(
        *f.script.callback_runs.lock().unwrap(),
        vec![b.run_id.clone(), b.run_id.clone()]
    );
    assert_eq!(
        f.script.model_runs.lock().unwrap().last().unwrap(),
        &(a.run_id.clone(), "openai".into())
    );
    {
        let prompts = f.script.model_prompts.lock().unwrap();
        // The paused B completion was never committed. Its hypothetical
        // assistant text cannot appear in the new A model's history.
        assert!(!prompts.last().unwrap().1.iter().any(|message| {
            message["role"] == "assistant"
                && message["content"]
                    .to_string()
                    .contains("The marker is marigold.")
        }));
    }
    runtime
        .acknowledge_drained(&a, &resumed.boundary)
        .await
        .unwrap();
    assert!(f.store.load(&channel(&b)).await.unwrap().cancelled);
    f.shutdown().await;
}
