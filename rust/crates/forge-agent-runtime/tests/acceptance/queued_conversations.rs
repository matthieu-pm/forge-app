use super::input_conversations::{engine, finish};
use super::*;
use async_trait::async_trait;
use forge_agent_runtime::{
    Error, Result,
    callback::{Capabilities, Request},
    engine::{Decision, Engine},
    execution::Features,
    model::{
        stream::{Completion, Finish},
        transport::{Model, Sink, Turn},
    },
    sandbox::Cancellation,
    tools::Executor,
};
use forge_core::agents::runtime::{
    DrainBoundary, HandoffPlan, IntentState, Preparation, QueuedInput,
};
use std::sync::{Arc, Mutex};
use tokio::time::Instant;
fn write(id: &str) -> Value {
    json!({"type":"tool-call","toolCallId":id,"toolName":"update_team","input":{"slug":"forge","settings":{"name":id}}})
}
fn intent(f: &Fixture, request: &str, approved: bool) -> QueuedInput {
    QueuedInput {
        intent_id: Uuid::new_v4(),
        conversation_id: f.conversation,
        request_id: request.parse().unwrap(),
        approved,
    }
}
async fn first(f: &Fixture) -> State {
    f.store
        .admit_managed_at(
            &f.channel,
            f.conversation,
            None,
            message("Start"),
            f.deadline,
            None,
        )
        .await
        .unwrap();
    let (lease, mut state) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(
        engine(vec![write("write-a")])
            .drive(
                &f.channel,
                &mut state,
                &lease,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    lease.release().await.unwrap();
    state
}
async fn ack(f: &Fixture, channel: &Channel) -> DrainBoundary {
    let boundary = f.store.load(channel).await.unwrap().boundary.unwrap();
    f.store
        .acknowledge_drained(channel, &boundary)
        .await
        .unwrap();
    boundary
}
async fn plan(f: &Fixture, channel: &Channel, boundary: &DrainBoundary) -> HandoffPlan {
    match f
        .store
        .prepare_handoff(channel, &boundary.conversation)
        .await
        .unwrap()
    {
        Preparation::Ready { plan } => plan,
        _ => panic!("expected a frozen handoff"),
    }
}
struct NextWrite;
#[async_trait]
impl Model for NextWrite {
    async fn generate(
        &self,
        _: &Channel,
        _: Turn<'_>,
        _: &Cancellation,
        _: &mut dyn Sink,
    ) -> Result<Completion> {
        Ok(Completion {
            content: vec![write("write-c")],
            finish: Finish::ToolCalls,
            usage: json!({"inputTokens":10,"outputTokens":5}),
        })
    }
}
#[derive(Default)]
struct DenyCalls(Mutex<Vec<String>>);
#[async_trait]
impl Capabilities for DenyCalls {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value> {
        assert_eq!(request.id, "teams.update");
        self.0.lock().unwrap().push(channel.run_id().into());
        Err(Error("APPROVAL_NOT_FOUND"))
    }
}
async fn successor_with_own_request(f: &Fixture) -> (Channel, State, Arc<DenyCalls>) {
    let prior = ack(f, &f.channel).await;
    let c = f.next("anthropic");
    f.store
        .admit_managed_at(
            &c,
            f.conversation,
            Some(f.run),
            message("yes"),
            f.deadline,
            Some(prior.conversation.generation),
        )
        .await
        .unwrap();
    let (lease, mut state) = f
        .store
        .acquire(&c, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let effects = Arc::new(DenyCalls::default());
    let engine = Engine::new(
        Arc::new(NextWrite),
        Arc::new(Executor {
            capabilities: effects.clone(),
            sandbox: None,
            features: Features {
                code_mode: true,
                programmatic_tools: true,
                write_tools: true,
            },
        }),
    );
    assert_eq!(
        engine
            .drive(
                &c,
                &mut state,
                &lease,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    lease.release().await.unwrap();
    (c, state, effects)
}
#[tokio::test]
async fn fifo_batch_uses_last_original_authority_without_moving_first_original_grant() {
    let f = Fixture::new().await;
    let a = first(&f).await;
    let ar = a.pending_requests()[0]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (c, cstate, effects) = successor_with_own_request(&f).await;
    let cr = cstate.pending_requests()[0]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ia = intent(&f, &ar, true);
    let ic = intent(&f, &cr, false);
    let before = f.store.load(&c).await.unwrap();
    let accepted = f.store.enqueue_input(&f.channel, &ia).await.unwrap();
    assert_eq!(accepted.sequence, 1);
    assert_eq!(f.store.enqueue_input(&c, &ic).await.unwrap().sequence, 2);
    assert_eq!(
        f.store.load(&c).await.unwrap().state.snapshot(),
        before.state.snapshot()
    );
    assert_eq!(f.store.load(&c).await.unwrap().boundary, before.boundary);
    assert!(
        f.store
            .respond(&f.channel, &ar, Decision::Approved)
            .await
            .is_err()
    );
    assert!(matches!(
        f.store
            .prepare_handoff(&c, &before.boundary.unwrap().conversation)
            .await
            .unwrap(),
        Preparation::AwaitingDrain
    ));
    let boundary = ack(&f, &c).await;
    let frozen = plan(&f, &c, &boundary).await;
    assert_eq!(frozen.anchor_intent_id, ia.intent_id);
    assert_eq!(frozen.intent_ids, vec![ia.intent_id, ic.intent_id]);
    assert_eq!(frozen.activation_run_id.to_string(), c.run_id());
    assert_eq!(frozen.authority.provider, "anthropic");
    assert_eq!(plan(&f, &f.channel, &boundary).await, frozen);
    assert!(
        f.store
            .activate_handoff(&f.channel, frozen.id, &boundary)
            .await
            .is_err()
    );
    let changed = channel(c.run_id().parse().unwrap(), "owner", "workspace", "openai");
    assert!(
        f.store
            .activate_handoff(&changed, frozen.id, &boundary)
            .await
            .is_err()
    );
    let activated = f
        .store
        .activate_handoff(&c, frozen.id, &boundary)
        .await
        .unwrap();
    assert_eq!(
        activated.input_generation,
        boundary.conversation.generation + 1
    );
    let retry = f
        .store
        .activate_handoff(&c, frozen.id, &boundary)
        .await
        .unwrap();
    assert!(retry.replayed && retry.current_delivery);
    assert_eq!(retry.stream_start_index, activated.stream_start_index);
    let receipt = f.store.enqueue_input(&f.channel, &ia).await.unwrap();
    assert_eq!(receipt.state, IntentState::Activated);
    assert_eq!(receipt.activation_run_id, Some(frozen.activation_run_id));
    assert_eq!(
        f.store.load(&f.channel).await.unwrap().state.usage(),
        (10, 5)
    );
    let state = finish(&f, &c).await;
    assert_eq!(state.usage(), (20, 10));
    assert_eq!(state.session_usage(), (30, 15));
    assert_eq!(*effects.0.lock().unwrap(), vec![c.run_id().to_owned()]);
    let stored: String =
        sqlx::query_scalar("SELECT plan::text FROM forge_runtime.input_handoffs WHERE id=$1")
            .bind(frozen.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!stored.contains("fixture-capability-token") && !stored.contains("model-access-token"));
}
#[tokio::test]
async fn invalidating_a_frozen_original_preserves_intent_data_and_requires_a_new_plan() {
    let f = Fixture::new().await;
    let a = first(&f).await;
    let (c, cstate, _) = successor_with_own_request(&f).await;
    let ia = intent(
        &f,
        a.pending_requests()[0]["requestId"].as_str().unwrap(),
        true,
    );
    let ic = intent(
        &f,
        cstate.pending_requests()[0]["requestId"].as_str().unwrap(),
        true,
    );
    f.store.enqueue_input(&f.channel, &ia).await.unwrap();
    f.store.enqueue_input(&c, &ic).await.unwrap();
    let boundary = ack(&f, &c).await;
    let old = plan(&f, &c, &boundary).await;
    assert!(f.store.cancel(&c).await.unwrap());
    assert!(
        f.store
            .activate_handoff(&c, old.id, &boundary)
            .await
            .is_err()
    );
    assert_eq!(
        f.store.enqueue_input(&c, &ic).await.unwrap().state,
        IntentState::Cancelled
    );
    let boundary = ack(&f, &c).await;
    let replacement = plan(&f, &f.channel, &boundary).await;
    assert_ne!(replacement.id, old.id);
    assert_eq!(replacement.activation_run_id, f.run);
    assert_eq!(replacement.intent_ids, vec![ia.intent_id]);
    f.store
        .activate_handoff(&f.channel, replacement.id, &boundary)
        .await
        .unwrap();
    let state = finish(&f, &f.channel).await;
    assert!(
        state
            .history()
            .iter()
            .filter(|message| message["role"] == "tool")
            .flat_map(|message| message["content"].as_array().unwrap())
            .any(|part| part["toolCallId"] == "write-c"
                && part["output"]["type"] == "execution-denied")
    );
    assert!(f.store.load(&c).await.unwrap().cancelled);
    let saved: (bool, String) =
        sqlx::query_as("SELECT approved,state FROM forge_runtime.input_intents WHERE intent_id=$1")
            .bind(ic.intent_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(saved, (true, "cancelled".into()));
}
#[tokio::test]
async fn failed_activation_transaction_does_not_spend_queue_and_exact_retry_keeps_one_receipt() {
    let f = Fixture::new().await;
    let a = first(&f).await;
    let input = intent(
        &f,
        a.pending_requests()[0]["requestId"].as_str().unwrap(),
        false,
    );
    f.store.enqueue_input(&f.channel, &input).await.unwrap();
    let boundary = ack(&f, &f.channel).await;
    let frozen = plan(&f, &f.channel, &boundary).await;
    let trigger = format!("queue_{}", f.run.simple());
    sqlx::raw_sql(&format!("CREATE FUNCTION forge_runtime.{trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON forge_runtime.input_deliveries FOR EACH ROW WHEN (NEW.run_id='{}'::uuid) EXECUTE FUNCTION forge_runtime.{trigger}();",f.run)).execute(&f.pool).await.unwrap();
    assert!(
        f.store
            .activate_handoff(&f.channel, frozen.id, &boundary)
            .await
            .is_err()
    );
    assert_eq!(
        f.store.load(&f.channel).await.unwrap().boundary,
        Some(boundary.clone())
    );
    assert_eq!(
        f.store
            .enqueue_input(&f.channel, &input)
            .await
            .unwrap()
            .state,
        IntentState::Prepared
    );
    sqlx::raw_sql(&format!("DROP TRIGGER {trigger} ON forge_runtime.input_deliveries; DROP FUNCTION forge_runtime.{trigger}();")).execute(&f.pool).await.unwrap();
    let (one, two) = tokio::join!(
        f.store.activate_handoff(&f.channel, frozen.id, &boundary),
        f.store.activate_handoff(&f.channel, frozen.id, &boundary)
    );
    let one = one.unwrap();
    let two = two.unwrap();
    assert_ne!(one.replayed, two.replayed);
    assert_eq!(one.stream_start_index, two.stream_start_index);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM forge_runtime.input_deliveries WHERE run_id=$1")
            .bind(f.run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn managed_upgrade_rejects_without_stranding_an_existing_unmanaged_conversation() {
    let f = Fixture::new().await;
    f.admit_first().await;
    f.complete(
        &f.channel,
        vec![json!({"type":"text","text":"Legacy answer"})],
    )
    .await;
    let b = f.next("anthropic");
    assert!(
        f.store
            .admit_managed_at(
                &b,
                f.conversation,
                Some(f.run),
                message("Next"),
                f.deadline,
                None
            )
            .await
            .is_err()
    );
    assert_eq!(f.head().await, f.run);
    assert!(!f.store.load(&f.channel).await.unwrap().managed);
    let ordinary = f
        .store
        .admit(&b, f.conversation, Some(f.run), message("Next"), f.deadline)
        .await
        .unwrap();
    assert!(!ordinary.managed);
    assert!(
        ordinary
            .state
            .history()
            .iter()
            .any(|message| message["role"] == "assistant"
                && message["content"][0]["text"] == "Legacy answer")
    );
}
#[tokio::test]
async fn expired_original_runtime_intent_is_retained_and_cannot_activate_or_refresh_its_deadline() {
    let f = Fixture::new().await;
    let a = first(&f).await;
    let input = intent(
        &f,
        a.pending_requests()[0]["requestId"].as_str().unwrap(),
        true,
    );
    f.store.enqueue_input(&f.channel, &input).await.unwrap();
    let boundary = ack(&f, &f.channel).await;
    let frozen = plan(&f, &f.channel, &boundary).await;
    sqlx::query("UPDATE forge_runtime.sessions SET deadline=clock_timestamp()-interval '1 second' WHERE run_id=$1").bind(f.run).execute(&f.pool).await.unwrap();
    assert!(
        f.store
            .activate_handoff(&f.channel, frozen.id, &boundary)
            .await
            .is_err()
    );
    let receipt = f.store.enqueue_input(&f.channel, &input).await.unwrap();
    assert_eq!(receipt.state, IntentState::Expired);
    assert!(receipt.approved);
    assert!(matches!(
        f.store
            .prepare_handoff(&f.channel, &boundary.conversation)
            .await
            .unwrap(),
        Preparation::Empty
    ));
    assert!(f.store.load(&f.channel).await.unwrap().deadline < Utc::now());
}
#[tokio::test]
async fn earlier_limit_reply_drops_as_stale_without_importing_its_provenance_into_last_authority() {
    let f = Fixture::new().await;
    f.store
        .admit_managed_at(
            &f.channel,
            f.conversation,
            None,
            message("Start"),
            f.deadline,
            None,
        )
        .await
        .unwrap();
    let (lease, mut a) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let mut limited = engine(vec![
        json!({"type":"tool-call","toolCallId":"before-limit","toolName":"get_team","input":{"slug":"forge"}}),
    ]);
    limited.max_input_tokens = 10;
    assert_eq!(
        limited
            .drive(
                &f.channel,
                &mut a,
                &lease,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    lease.release().await.unwrap();
    let request = a.pending_requests()[0].clone();
    assert_eq!(request["kind"], "session-limit");
    let boundary = ack(&f, &f.channel).await;
    let c = f.next("anthropic");
    f.store
        .admit_managed_at(
            &c,
            f.conversation,
            Some(f.run),
            message("Approve"),
            f.deadline,
            Some(boundary.conversation.generation),
        )
        .await
        .unwrap();
    let (lease, mut current) = f
        .store
        .acquire(&c, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(
        engine(vec![write("write-c")])
            .drive(
                &c,
                &mut current,
                &lease,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    lease.release().await.unwrap();
    let old = request["requestId"].as_str().unwrap();
    let ia = intent(&f, old, true);
    let ic = intent(
        &f,
        current.pending_requests()[0]["requestId"].as_str().unwrap(),
        false,
    );
    f.store.enqueue_input(&f.channel, &ia).await.unwrap();
    f.store.enqueue_input(&c, &ic).await.unwrap();
    let boundary = ack(&f, &c).await;
    let frozen = plan(&f, &c, &boundary).await;
    f.store
        .activate_handoff(&c, frozen.id, &boundary)
        .await
        .unwrap();
    let activated = f.store.load(&c).await.unwrap().state;
    assert!(activated.issued_request(old).is_none());
    let user_history = activated
        .history()
        .iter()
        .filter(|message| message["role"] == "user")
        .cloned()
        .collect::<Vec<_>>();
    assert!(!serde_json::to_string(&user_history).unwrap().contains(old));
    assert_eq!(
        activated.snapshot()["budget"]["granted"],
        current.snapshot()["budget"]["granted"]
    );
}
