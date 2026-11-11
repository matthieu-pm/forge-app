use chrono::{DateTime, Utc};
use forge_agent_runtime::{
    auth::Channel,
    engine::{Journal, Phase, State},
    journal::Store,
};
use forge_core::agents::{
    approval,
    tokens::{Kind, mint},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::time::Duration;
use uuid::Uuid;
const SECRET: &str = "public-conversation-fixture-signing-secret";
fn channel(run: Uuid, user: &str, workspace: &str, provider: &str) -> Channel {
    let now = Utc::now().timestamp();
    let token=mint(SECRET,Kind::RuntimeChannel,json!({"sub":user,"workspaceId":workspace,"runId":run,"forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-access-token","provider":provider,"modelId":"fixture-model","reasoningEffort":"medium"}),now,900.).unwrap();
    Channel::verify(SECRET, &format!("Bearer {token}"), now).unwrap()
}
fn message(text: &str) -> Value {
    json!({"role":"user","content":[{"type":"text","text":text}]})
}
struct Fixture {
    pool: PgPool,
    store: Store,
    conversation: Uuid,
    run: Uuid,
    channel: Channel,
    deadline: DateTime<Utc>,
}
impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("FORGE_RUST_RUNTIME_TEST_DATABASE_URL")
            .expect("Use the disposable PostgreSQL milestone runner");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert_eq!(parsed.path(), "/forge_rust_runtime");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&url)
            .await
            .unwrap();
        Store::install(&pool).await.unwrap();
        let run = Uuid::new_v4();
        Self {
            store: Store::new(pool.clone()),
            pool,
            conversation: Uuid::new_v4(),
            run,
            channel: channel(run, "owner", "workspace", "openai"),
            deadline: DateTime::from_timestamp_millis(Utc::now().timestamp_millis() + 60000)
                .unwrap(),
        }
    }
    fn next(&self, provider: &str) -> Channel {
        channel(Uuid::new_v4(), "owner", "workspace", provider)
    }
    async fn admit_first(&self) -> State {
        self.store
            .admit(
                &self.channel,
                self.conversation,
                None,
                message("Remember marigold."),
                self.deadline,
            )
            .await
            .unwrap()
            .state
    }
    async fn complete(&self, channel: &Channel, content: Vec<Value>) {
        let (lease, state) = self
            .store
            .acquire(channel, Uuid::new_v4(), Duration::from_secs(30))
            .await
            .unwrap();
        let mut snapshot = state.snapshot();
        snapshot["revision"] = json!(state.revision() + 1);
        snapshot["phase"] = json!("complete");
        snapshot["input_tokens"] = json!(123);
        snapshot["output_tokens"] = json!(17);
        snapshot["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"assistant","content":content}));
        let next = State::restore(snapshot, channel).unwrap();
        lease
            .commit(
                state.revision(),
                &next,
                &[json!({"type":"turn.completed","data":{}})],
            )
            .await
            .unwrap();
        lease.release().await.unwrap();
    }
    async fn head(&self) -> Uuid {
        sqlx::query_scalar("SELECT last_run_id FROM forge_runtime.conversations WHERE id=$1")
            .bind(self.conversation)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}
#[tokio::test]
async fn completed_turns_keep_materialized_history_across_provider_changes_without_reusing_provider_items()
 {
    let f = Fixture::new().await;
    f.admit_first().await;
    f.complete(&f.channel,vec![json!({"type":"reasoning","text":"Private reasoning","providerOptions":{"openai":{"itemId":"rs_previous"}}}),json!({"type":"text","text":"The marker is marigold.","providerOptions":{"openai":{"itemId":"msg_previous"}}})]).await;
    let next = f.next("anthropic");
    let saved = f
        .store
        .admit(
            &next,
            f.conversation,
            Some(f.run),
            message("What is the marker?"),
            f.deadline,
        )
        .await
        .unwrap();
    assert_eq!(saved.state.history().len(), 4);
    assert_eq!(saved.state.history()[1], message("Remember marigold."));
    assert_eq!(
        saved.state.history()[2],
        json!({"role":"assistant","content":[{"type":"text","text":"The marker is marigold."}]})
    );
    assert_eq!(saved.state.history()[3], message("What is the marker?"));
    assert_eq!(saved.state.usage(), (0, 0));
    assert_eq!(saved.state.snapshot()["decisions"], json!({}));
    assert_eq!(saved.state.phase(), Phase::Ready);
    assert_eq!(f.head().await.to_string(), next.run_id());
    let request =
        forge_agent_runtime::model::request::build(&next, saved.state.history(), &[], None)
            .unwrap();
    let text = request.body.to_string();
    assert!(text.contains("marigold"));
    assert!(!text.contains("msg_previous"));
    assert!(!text.contains("Private reasoning"));
}
#[tokio::test]
async fn concurrent_siblings_serialize_and_identical_admission_retries_reuse_the_saved_turn() {
    let f = Fixture::new().await;
    let (a, b) = tokio::join!(
        f.store.admit(
            &f.channel,
            f.conversation,
            None,
            message("Remember marigold."),
            f.deadline
        ),
        f.store.admit(
            &f.channel,
            f.conversation,
            None,
            message("Remember marigold."),
            f.deadline
        )
    );
    assert_eq!(a.unwrap().state.snapshot(), b.unwrap().state.snapshot());
    f.complete(&f.channel, vec![json!({"type":"text","text":"Saved."})])
        .await;
    let a = f.next("openai");
    let b = f.next("openai");
    let (left, right) = tokio::join!(
        f.store
            .admit(&a, f.conversation, Some(f.run), message("A"), f.deadline),
        f.store
            .admit(&b, f.conversation, Some(f.run), message("B"), f.deadline)
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let (winner, text) = if left.is_ok() { (&a, "A") } else { (&b, "B") };
    let saved = f.store.load(winner).await.unwrap();
    let retry = f
        .store
        .admit(
            winner,
            f.conversation,
            Some(f.run),
            message(text),
            f.deadline,
        )
        .await
        .unwrap();
    assert_eq!(retry.state.snapshot(), saved.state.snapshot());
    assert_eq!(f.head().await.to_string(), winner.run_id());
}
#[tokio::test]
async fn conversation_scope_parent_binding_and_active_parent_blocks_are_enforced() {
    let f = Fixture::new().await;
    f.admit_first().await;
    for (user, workspace) in [("other", "workspace"), ("owner", "other")] {
        let wrong = channel(Uuid::new_v4(), user, workspace, "openai");
        assert!(
            f.store
                .admit(
                    &wrong,
                    f.conversation,
                    Some(f.run),
                    message("Steal"),
                    f.deadline
                )
                .await
                .is_err()
        );
    }
    let next = f.next("openai");
    assert!(
        f.store
            .admit(
                &next,
                f.conversation,
                Some(f.run),
                message("Too soon"),
                f.deadline
            )
            .await
            .is_err()
    );
    assert!(
        f.store
            .admit(
                &next,
                f.conversation,
                None,
                message("Overwrite"),
                f.deadline
            )
            .await
            .is_err()
    );
    assert!(
        f.store
            .admit(
                &next,
                Uuid::new_v4(),
                Some(f.run),
                message("Wrong conversation"),
                f.deadline
            )
            .await
            .is_err()
    );
    assert!(
        f.store
            .admit(
                &f.channel,
                f.conversation,
                Some(f.run),
                message("Cycle"),
                f.deadline
            )
            .await
            .is_err()
    );
    assert!(
        f.store
            .admit(
                &next,
                f.conversation,
                Some(f.run),
                json!({"role":"assistant","content":[]}),
                f.deadline
            )
            .await
            .is_err()
    );
    assert_eq!(f.head().await, f.run);
    assert!(f.store.load(&next).await.is_err());
}
#[tokio::test]
async fn cancelled_tool_steps_preserve_completed_results_and_mark_unconfirmed_or_unexecuted_calls()
{
    let f = Fixture::new().await;
    f.admit_first().await;
    let (lease, state) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let mut snapshot = state.snapshot();
    snapshot["revision"] = json!(1);
    snapshot["phase"] = json!("tools");
    snapshot["next_call"] = json!(1);
    let mut calls = vec![];
    let mut parts = vec![];
    for (id, phase) in [
        ("done", "complete"),
        ("unknown", "calling"),
        ("not-started", "queued"),
    ] {
        let input = json!({"slug":"forge"});
        let output=(phase=="complete").then(||json!({"type":"json","value":{"name":"Observed","providerOptions":{"userData":"preserved"}}}));
        calls.push(json!({"id":id,"name":"get_team","input":input,"input_hash":approval::input_hash(&input),"phase":phase,"request_id":null,"decision":null,"output":output}));
        parts.push(json!({"type":"tool-call","toolCallId":id,"toolName":"get_team","input":input,"providerOptions":{"openai":{"itemId":format!("fc_{id}")}}}));
    }
    snapshot["calls"] = json!(calls);
    snapshot["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"role":"assistant","content":parts}));
    let state = State::restore(snapshot, &f.channel).unwrap();
    lease.commit(0, &state, &[]).await.unwrap();
    f.store.cancel(&f.channel).await.unwrap();
    let next = f.next("custom-openai");
    let saved = f
        .store
        .admit(
            &next,
            f.conversation,
            Some(f.run),
            message("Continue carefully."),
            f.deadline,
        )
        .await
        .unwrap();
    let history = saved.state.history();
    let results = history[3]["content"].as_array().unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(
        results[0]["output"]["value"]["providerOptions"]["userData"],
        "preserved"
    );
    assert_eq!(results[1]["output"]["type"], "error-text");
    assert!(
        results[1]["output"]["value"]
            .as_str()
            .unwrap()
            .contains("could be confirmed")
    );
    assert_eq!(results[2]["output"]["type"], "execution-denied");
    assert_eq!(saved.state.snapshot()["calls"], json!([]));
    assert_eq!(saved.state.snapshot()["decisions"], json!({}));
    assert_eq!(saved.state.phase(), Phase::Ready);
    assert!(
        lease
            .append(1, json!({"type":"fixture.late","data":{}}))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn old_admission_replay_does_not_rewind_the_conversation_or_depend_on_deleted_ancestors() {
    let f = Fixture::new().await;
    f.admit_first().await;
    f.complete(&f.channel, vec![json!({"type":"text","text":"Saved."})])
        .await;
    let second = f.next("openai");
    f.store
        .admit(
            &second,
            f.conversation,
            Some(f.run),
            message("Second"),
            f.deadline,
        )
        .await
        .unwrap();
    f.complete(&second, vec![json!({"type":"text","text":"Second reply."})])
        .await;
    let third = f.next("openai");
    let second_id = second.run_id().parse().unwrap();
    f.store
        .admit(
            &third,
            f.conversation,
            Some(second_id),
            message("Third"),
            f.deadline,
        )
        .await
        .unwrap();
    assert_eq!(
        f.store
            .admit(
                &f.channel,
                f.conversation,
                None,
                message("Remember marigold."),
                f.deadline
            )
            .await
            .unwrap()
            .state
            .phase(),
        Phase::Complete
    );
    assert_eq!(f.head().await.to_string(), third.run_id());
    assert!(
        f.store
            .admit(
                &second,
                f.conversation,
                Some(f.run),
                message("Changed"),
                f.deadline
            )
            .await
            .is_err()
    );
    sqlx::query("DELETE FROM forge_runtime.sessions WHERE run_id=$1")
        .bind(f.run)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .admit(
                &second,
                f.conversation,
                Some(f.run),
                message("Second"),
                f.deadline
            )
            .await
            .unwrap()
            .state
            .phase(),
        Phase::Complete
    );
    assert_eq!(f.head().await.to_string(), third.run_id());
    assert!(
        f.store
            .load(&third)
            .await
            .unwrap()
            .state
            .history()
            .to_vec()
            .iter()
            .any(|v| v == &message("Remember marigold."))
    );
}
#[tokio::test]
async fn private_schema_upgrade_preserves_existing_runs_and_rejects_changed_migration_digests() {
    let f = Fixture::new().await;
    let original = std::env::var("FORGE_RUST_RUNTIME_TEST_DATABASE_URL").unwrap();
    let name = format!("forge_runtime_upgrade_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&f.pool)
        .await
        .unwrap();
    let mut url = url::Url::parse(&original).unwrap();
    url.set_path(&format!("/{name}"));
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(url.as_str())
        .await
        .unwrap();
    let first = include_str!("../migrations/0001_runtime.sql");
    sqlx::raw_sql(first).execute(&pool).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE forge_runtime.migrations(version integer PRIMARY KEY,digest text NOT NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO forge_runtime.migrations VALUES(1,$1)")
        .bind(format!("{:x}", Sha256::digest(first.as_bytes())))
        .execute(&pool)
        .await
        .unwrap();
    let state = State::new(&f.channel, vec![message("Before upgrade")]).unwrap();
    sqlx::query("INSERT INTO forge_runtime.sessions(run_id,workspace_id,user_id,initial_hash,engine_state,deadline) VALUES($1,'workspace','owner',$2,$3,$4)").bind(f.run).bind("0".repeat(64)).bind(state.snapshot()).bind(f.deadline).execute(&pool).await.unwrap();
    assert!(Store::verify(&pool).await.is_err());
    Store::install(&pool).await.unwrap();
    Store::verify(&pool).await.unwrap();
    assert_eq!(
        Store::new(pool.clone())
            .load(&f.channel)
            .await
            .unwrap()
            .state
            .snapshot(),
        state.snapshot()
    );
    sqlx::query("UPDATE forge_runtime.migrations SET digest='changed' WHERE version=2")
        .execute(&pool)
        .await
        .unwrap();
    assert!(Store::install(&pool).await.is_err());
    assert!(Store::verify(&pool).await.is_err());
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {name}"))
        .execute(&f.pool)
        .await
        .unwrap();
}
