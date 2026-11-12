use super::*;
use async_trait::async_trait;
use forge_agent_runtime::{
    Result,
    callback::{Capabilities, Request},
    engine::{Decision, Engine},
    execution::Features,
    journal::Lease,
    model::{
        stream::{Completion, Finish},
        transport::{Model, Sink, Turn},
    },
    sandbox::Cancellation,
    tools::Executor,
};
use std::sync::Arc;
use tokio::time::Instant;

struct ModelStep(Vec<Value>);
#[async_trait]
impl Model for ModelStep {
    async fn generate(
        &self,
        _: &Channel,
        _: Turn<'_>,
        _: &Cancellation,
        _: &mut dyn Sink,
    ) -> Result<Completion> {
        Ok(Completion {
            content: self.0.clone(),
            finish: if self.0.iter().any(|p| p["type"] == "tool-call") {
                Finish::ToolCalls
            } else {
                Finish::Stop
            },
            usage: json!({"inputTokens":10,"outputTokens":5}),
        })
    }
}
struct NoEffects;
#[async_trait]
impl Capabilities for NoEffects {
    async fn call(&self, _: &Channel, request: Request) -> Result<Value> {
        assert_eq!(request.id, "teams.get", "Only pre-pause reads may dispatch");
        Ok(
            json!({"id":"11111111-1111-4111-8111-111111111111","slug":"forge","identifier":"FOR","name":"Read before waiting","timezone":"UTC","description":""}),
        )
    }
}
fn engine(content: Vec<Value>) -> Engine {
    Engine::new(
        Arc::new(ModelStep(content)),
        Arc::new(Executor {
            capabilities: Arc::new(NoEffects),
            sandbox: None,
            features: Features {
                code_mode: true,
                programmatic_tools: true,
                write_tools: true,
            },
        }),
    )
}
fn call(id: &str, name: &str, input: Value) -> Value {
    json!({"type":"tool-call","toolCallId":id,"toolName":name,"input":input})
}
fn choice(id: &str) -> Value {
    call(
        id,
        "ask_question",
        json!({"prompt":"Which workspace?","allowFreeform":false,"options":[{"id":"first","label":"First"},{"id":"second","label":"Second"}]}),
    )
}
pub(super) async fn parked(f: &Fixture, calls: Vec<Value>) -> (Lease, State) {
    f.admit_first().await;
    let (lease, mut state) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(
        engine(calls)
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
    (lease, state)
}
pub(super) async fn finish(f: &Fixture, channel: &Channel) -> State {
    let (lease, mut state) = f
        .store
        .acquire(channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(
        engine(vec![json!({"type":"text","text":"Saved the answer."})])
            .drive(
                channel,
                &mut state,
                &lease,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Complete
    );
    lease.release().await.unwrap();
    state
}
fn results(state: &State) -> Vec<Value> {
    state
        .history()
        .iter()
        .filter(|m| m["role"] == "tool")
        .flat_map(|m| m["content"].as_array().unwrap().clone())
        .collect()
}

#[tokio::test]
async fn question_answer_commits_one_successor_receipt_and_fences_the_parked_worker() {
    let f = Fixture::new().await;
    let question_id = Uuid::new_v4().to_string();
    let (lease, parent) = parked(
        &f,
        vec![
            choice(&question_id),
            call(
                "opaque-question",
                "ask_question",
                json!({"prompt":"Confirm your choice"}),
            ),
        ],
    )
    .await;
    assert_eq!(parent.pending_questions().len(), 2);
    // Even UUID-shaped question identifiers are never boolean approvals.
    assert!(
        f.store
            .respond(&f.channel, &question_id, Decision::Approved)
            .await
            .is_err()
    );
    let child = f.next("anthropic");
    let recovered = Store::new(f.pool.clone());
    let (a, b) = tokio::join!(
        recovered.admit(
            &child,
            f.conversation,
            Some(f.run),
            message("2"),
            f.deadline
        ),
        recovered.admit(
            &child,
            f.conversation,
            Some(f.run),
            message("2"),
            f.deadline
        )
    );
    let a = a.unwrap();
    assert_eq!(a.state.snapshot(), b.unwrap().state.snapshot());
    assert_eq!(a.next_index, 2);
    assert_eq!(recovered.events(&child, 0, 64).await.unwrap().len(), 2);
    let old = recovered.load(&f.channel).await.unwrap();
    assert_eq!(old.state.phase(), Phase::Waiting);
    assert_eq!(
        old.continued_by.map(|id| id.to_string()),
        Some(child.run_id().into())
    );
    assert!(!old.worker_active);
    assert!(
        lease
            .append(
                parent.revision(),
                json!({"type":"message.appended","data":{"messageDelta":"late"}})
            )
            .await
            .is_err()
    );
    assert!(
        recovered
            .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
            .await
            .is_err()
    );
    assert!(!recovered.cancel(&f.channel).await.unwrap());
    assert!(
        recovered
            .admit(
                &child,
                f.conversation,
                Some(f.run),
                message("1"),
                f.deadline
            )
            .await
            .is_err()
    );
    let state = finish(&f, &child).await;
    let answers = results(&state);
    assert_eq!(
        answers[0]["output"]["value"],
        json!({"status":"answered","optionId":"second"})
    );
    assert_eq!(
        answers[1]["output"]["value"],
        json!({"status":"answered","text":"2"})
    );
    assert!(!state.history().iter().any(|m| m == &message("2")));
    assert_eq!(state.session_usage(), (20, 10));
    // Replay remains self-contained after old private journal retention.
    sqlx::query("DELETE FROM forge_runtime.sessions WHERE run_id=$1")
        .bind(f.run)
        .execute(&f.pool)
        .await
        .unwrap();
    let replay = recovered
        .admit(
            &child,
            f.conversation,
            Some(f.run),
            message("2"),
            f.deadline,
        )
        .await
        .unwrap();
    assert_eq!(replay.state.snapshot(), state.snapshot());
}

#[tokio::test]
async fn stale_foreign_or_competing_question_answers_do_not_consume_the_wrong_head() {
    let f = Fixture::new().await;
    parked(&f, vec![choice("question-1")]).await;
    let wrong = channel(Uuid::new_v4(), "other-user", "workspace", "openai");
    assert!(
        f.store
            .admit(
                &wrong,
                f.conversation,
                Some(f.run),
                message("1"),
                f.deadline
            )
            .await
            .is_err()
    );
    let a = f.next("openai");
    assert!(
        f.store
            .admit(&a, Uuid::new_v4(), Some(f.run), message("1"), f.deadline)
            .await
            .is_err()
    );
    assert!(
        f.store
            .admit(
                &a,
                f.conversation,
                Some(f.run),
                message("1"),
                Utc::now() - chrono::Duration::seconds(1)
            )
            .await
            .is_err()
    );
    assert!(
        f.store
            .load(&f.channel)
            .await
            .unwrap()
            .continued_by
            .is_none()
    );
    let b = f.next("openai");
    let (left, right) = tokio::join!(
        f.store
            .admit(&a, f.conversation, Some(f.run), message("1"), f.deadline),
        f.store
            .admit(&b, f.conversation, Some(f.run), message("2"), f.deadline)
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let (winner, loser) = if left.is_ok() { (&a, &b) } else { (&b, &a) };
    assert_eq!(f.head().await.to_string(), winner.run_id());
    assert!(f.store.load(loser).await.is_err());
    assert_eq!(
        f.store
            .load(&f.channel)
            .await
            .unwrap()
            .continued_by
            .unwrap()
            .to_string(),
        winner.run_id()
    );
}

#[tokio::test]
async fn unmatched_question_becomes_ignored_and_the_composer_message_is_preserved() {
    let f = Fixture::new().await;
    parked(&f, vec![choice("question-1")]).await;
    let child = f.next("openai");
    f.store
        .admit(
            &child,
            f.conversation,
            Some(f.run),
            message("Change the subject"),
            f.deadline,
        )
        .await
        .unwrap();
    let state = finish(&f, &child).await;
    assert_eq!(
        results(&state)[0]["output"]["value"],
        json!({"status":"ignored"})
    );
    assert!(
        state
            .history()
            .iter()
            .any(|m| m == &message("Change the subject"))
    );
}

#[tokio::test]
async fn cancelled_questions_survive_and_reads_completed_before_the_pause_are_preserved() {
    let f = Fixture::new().await;
    parked(
        &f,
        vec![
            choice("question-1"),
            call("queued-read", "get_team", json!({"slug":"forge"})),
        ],
    )
    .await;
    f.store.cancel(&f.channel).await.unwrap();
    let child = f.next("openai");
    f.store
        .admit(
            &child,
            f.conversation,
            Some(f.run),
            message("Second"),
            f.deadline,
        )
        .await
        .unwrap();
    let state = finish(&f, &child).await;
    let outputs = results(&state);
    assert_eq!(
        outputs[0]["output"]["value"],
        json!({"status":"answered","optionId":"second"})
    );
    assert_eq!(outputs[1]["output"]["type"], "json");
    assert_eq!(outputs[1]["output"]["value"]["name"], "Read before waiting");
    assert!(f.store.load(&f.channel).await.unwrap().cancelled);
}
