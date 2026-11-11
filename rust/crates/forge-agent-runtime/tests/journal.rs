use async_trait::async_trait;
use chrono::{DateTime, Utc};
use forge_agent_runtime::{
    Result,
    auth::Channel,
    callback::{Capabilities, Request},
    engine::{Decision, Engine, Journal, Phase, State},
    execution::Features,
    journal::Store,
    model::{
        stream::{Completion, Delta, Finish},
        transport::{Model, Sink, Turn},
    },
    sandbox::Cancellation,
    tools::Executor,
};
use forge_core::agents::tokens::{Kind, mint};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;
use uuid::Uuid;
fn channel(run: Uuid, user: &str, workspace: &str, model: &str) -> Channel {
    let secret = "public-private-journal-fixture-secret";
    let token=mint(secret,Kind::RuntimeChannel,json!({"sub":user,"workspaceId":workspace,"runId":run,"forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-access-token","provider":"openai","modelId":model,"reasoningEffort":"medium"}),1000,900.).unwrap();
    Channel::verify(secret, &format!("Bearer {token}"), 1001).unwrap()
}
struct Fixture {
    pool: PgPool,
    store: Store,
    channel: Channel,
    state: State,
    run: Uuid,
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
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&url)
            .await
            .unwrap();
        Store::install(&pool).await.unwrap();
        let run = Uuid::new_v4();
        let channel = channel(run, "fixture-user", "fixture-workspace", "fixture-model");
        let state = State::new(
            &channel,
            vec![json!({"role":"user","content":[{"type":"text","text":"Hello"}]})],
        )
        .unwrap();
        let deadline =
            DateTime::from_timestamp_millis(Utc::now().timestamp_millis() + 60000).unwrap();
        let store = Store::new(pool.clone());
        store.create(&channel, &state, deadline).await.unwrap();
        Self {
            pool,
            store,
            channel,
            state,
            run,
            deadline,
        }
    }
    fn next(&self, revision: u64) -> State {
        let mut snapshot = self.state.snapshot();
        snapshot["revision"] = json!(revision);
        snapshot["phase"] = json!("generating");
        State::restore(snapshot, &self.channel).unwrap()
    }
}
fn event(value: Value) -> Value {
    json!({"type":"fixture.event","data":{"value":value}})
}
#[tokio::test]
async fn admission_is_idempotent_scoped_and_uses_only_the_explicit_private_schema() {
    let f = Fixture::new().await;
    Store::install(&f.pool).await.unwrap();
    let (a, b) = tokio::join!(
        f.store.create(&f.channel, &f.state, f.deadline),
        f.store.create(&f.channel, &f.state, f.deadline)
    );
    assert_eq!(a.unwrap().state.snapshot(), b.unwrap().state.snapshot());
    let wrong = channel(f.run, "another-user", "fixture-workspace", "fixture-model");
    assert!(f.store.load(&wrong).await.is_err());
    assert!(f.store.events(&wrong, 0, 32).await.is_err());
    assert!(f.store.cancel(&wrong).await.is_err());
    let wrong = channel(f.run, "fixture-user", "another-workspace", "fixture-model");
    assert!(f.store.load(&wrong).await.is_err());
    let changed = State::new(
        &f.channel,
        vec![json!({"role":"user","content":[{"type":"text","text":"Changed"}]})],
    )
    .unwrap();
    assert!(
        f.store
            .create(&f.channel, &changed, f.deadline)
            .await
            .is_err()
    );
    assert!(
        f.store
            .create(
                &f.channel,
                &f.state,
                f.deadline + chrono::Duration::seconds(1)
            )
            .await
            .is_err()
    );
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(tables, 0);
    let snapshot: String =
        sqlx::query_scalar("SELECT engine_state::text FROM forge_runtime.sessions WHERE run_id=$1")
            .bind(f.run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!snapshot.contains("fixture-capability-token"));
    assert!(!snapshot.contains("model-access-token"));
}
#[tokio::test]
async fn only_one_worker_claims_and_expired_ownership_cannot_publish_or_release_its_replacement() {
    let f = Fixture::new().await;
    let ttl = Duration::from_secs(30);
    let (a, b) = tokio::join!(
        f.store.acquire(&f.channel, Uuid::new_v4(), ttl),
        f.store.acquire(&f.channel, Uuid::new_v4(), ttl)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let (old, _) = a.or(b).unwrap();
    old.append(0, event(json!("first"))).await.unwrap();
    sqlx::query("UPDATE forge_runtime.sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1").bind(f.run).execute(&f.pool).await.unwrap();
    let (new, _) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), ttl)
        .await
        .unwrap();
    assert!(old.append(0, event(json!("stale"))).await.is_err());
    assert!(old.commit(0, &f.next(1), &[]).await.is_err());
    assert!(old.renew().await.is_err());
    assert!(!old.release().await.unwrap());
    new.append(0, event(json!("second"))).await.unwrap();
    let events = f.store.events(&f.channel, 0, 32).await.unwrap();
    assert_eq!(events.iter().map(|v| v.index).collect::<Vec<_>>(), [0, 1]);
    assert_eq!(events[1].value["data"]["value"], "second");
    assert!(new.release().await.unwrap());
    assert!(!new.release().await.unwrap());
}
#[tokio::test]
async fn state_and_event_batch_rollback_together_without_cursor_gaps() {
    let f = Fixture::new().await;
    let (lease, _) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let name = format!("reject_{}", f.run.simple());
    let ddl = format!(
        "CREATE FUNCTION forge_runtime.{name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-database-detail'; END $$; CREATE TRIGGER {name} BEFORE INSERT ON forge_runtime.events FOR EACH ROW WHEN (NEW.run_id='{}'::uuid AND NEW.event->>'type'='fixture.fail') EXECUTE FUNCTION forge_runtime.{name}();",
        f.run
    );
    sqlx::raw_sql(&ddl).execute(&f.pool).await.unwrap();
    let error = lease
        .commit(
            0,
            &f.next(1),
            &[
                event(json!("rolled back")),
                json!({"type":"fixture.fail","data":{}}),
            ],
        )
        .await
        .err()
        .unwrap();
    assert!(!error.to_string().contains("private-database-detail"));
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {name} ON forge_runtime.events; DROP FUNCTION forge_runtime.{name}();"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    let saved = f.store.load(&f.channel).await.unwrap();
    assert_eq!(saved.state.revision(), 0);
    assert_eq!(saved.next_index, 0);
    assert!(f.store.events(&f.channel, 0, 32).await.unwrap().is_empty());
    lease
        .commit(0, &f.next(1), &[event(json!("one")), event(json!("two"))])
        .await
        .unwrap();
    assert!(lease.append(0, event(json!("old revision"))).await.is_err());
    let events = f.store.events(&f.channel, 0, 32).await.unwrap();
    assert_eq!(events.iter().map(|v| v.index).collect::<Vec<_>>(), [0, 1]);
    let again = f.store.events(&f.channel, 0, 32).await.unwrap();
    assert_eq!(events[0].value, again[0].value);
    assert_eq!(events[1].value, again[1].value);
    assert!(events[0].value["_meta"]["id"].is_string());
    assert_eq!(f.store.load(&f.channel).await.unwrap().state.revision(), 1);
}
#[tokio::test]
async fn cancellation_is_idempotent_fences_workers_and_has_reserved_event_capacity() {
    let f = Fixture::new().await;
    let (lease, _) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    sqlx::query("UPDATE forge_runtime.sessions SET journal_bytes=67108864-4096-10 WHERE run_id=$1")
        .bind(f.run)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(lease.append(0, event(json!("over quota"))).await.is_err());
    let cancel_channel = channel(
        f.run,
        "fixture-user",
        "fixture-workspace",
        "cancel-placeholder",
    );
    assert!(f.store.cancel(&cancel_channel).await.unwrap());
    assert!(!f.store.cancel(&cancel_channel).await.unwrap());
    assert!(f.store.load(&f.channel).await.unwrap().cancelled);
    assert!(lease.commit(0, &f.next(1), &[]).await.is_err());
    assert!(
        lease
            .append(0, event(json!("after cancellation")))
            .await
            .is_err()
    );
    assert!(lease.renew().await.is_err());
    assert!(
        f.store
            .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
            .await
            .is_err()
    );
    let events = f.store.events(&f.channel, 0, 32).await.unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].value["type"], "turn.cancelled");
    assert_eq!(events[1].value["type"], "session.waiting");
}
#[tokio::test]
async fn renewal_preserves_the_original_deadline_and_expired_runs_cannot_be_claimed() {
    let f = Fixture::new().await;
    let (lease, _) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(60))
        .await
        .unwrap();
    lease.renew().await.unwrap();
    let (deadline, until): (DateTime<Utc>, DateTime<Utc>) =
        sqlx::query_as("SELECT deadline,lease_until FROM forge_runtime.sessions WHERE run_id=$1")
            .bind(f.run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(deadline, f.deadline);
    assert!(until <= deadline);
    sqlx::query("UPDATE forge_runtime.sessions SET deadline=clock_timestamp()-interval '1 second' WHERE run_id=$1").bind(f.run).execute(&f.pool).await.unwrap();
    assert!(lease.renew().await.is_err());
    assert!(lease.append(0, event(json!("expired"))).await.is_err());
    assert!(
        f.store
            .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
            .await
            .is_err()
    );
    assert!(f.store.cancel(&f.channel).await.unwrap());
}
#[tokio::test]
async fn lease_must_still_be_live_after_database_work_before_commit() {
    let f = Fixture::new().await;
    let (lease, _) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(1))
        .await
        .unwrap();
    let name = format!("delay_{}", f.run.simple());
    let ddl = format!(
        "CREATE FUNCTION forge_runtime.{name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE INSERT ON forge_runtime.events FOR EACH ROW WHEN (NEW.run_id='{}'::uuid) EXECUTE FUNCTION forge_runtime.{name}();",
        f.run
    );
    sqlx::raw_sql(&ddl).execute(&f.pool).await.unwrap();
    assert!(
        lease
            .commit(0, &f.next(1), &[event(json!("late"))])
            .await
            .is_err()
    );
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {name} ON forge_runtime.events; DROP FUNCTION forge_runtime.{name}();"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(f.store.load(&f.channel).await.unwrap().state.revision(), 0);
    assert!(f.store.events(&f.channel, 0, 32).await.unwrap().is_empty());
}
#[tokio::test]
async fn replay_pages_preserve_large_unicode_and_deep_payloads_with_byte_bounds() {
    let f = Fixture::new().await;
    let (lease, _) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let text = "😀".repeat(1024 * 1024 + 250);
    let deep = (0..140).fold(json!({"text":"hé😀"}), |v, _| json!({"child":v}));
    lease
        .append(0, event(json!({"text":text,"deep":deep})))
        .await
        .unwrap();
    lease.append(0, event(json!({"text":text}))).await.unwrap();
    let first = f.store.events(&f.channel, 0, 64).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].value["data"]["value"]["deep"], deep);
    assert_eq!(first[0].value["data"]["value"]["text"], text);
    let second = f.store.events(&f.channel, 1, 64).await.unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].index, 1);
    assert!(f.store.events(&f.channel, 0, 65).await.is_err());
}
struct ModelFixture;
#[async_trait]
impl Model for ModelFixture {
    async fn generate(
        &self,
        _: &Channel,
        turn: Turn<'_>,
        _: &Cancellation,
        sink: &mut dyn Sink,
    ) -> Result<Completion> {
        let done = turn.prompt.iter().any(|v| v["role"] == "tool");
        let content = if done {
            sink.emit(Delta::Text {
                id: "answer".into(),
                text: "Saved.".into(),
            })
            .await?;
            vec![json!({"type":"text","text":"Saved."})]
        } else {
            vec![
                json!({"type":"tool-call","toolCallId":"change-team","toolName":"update_team","input":{"slug":"forge","settings":{"name":"Changed"}}}),
            ]
        };
        Ok(Completion {
            content,
            finish: if done {
                Finish::Stop
            } else {
                Finish::ToolCalls
            },
            usage: json!({"inputTokens":10,"outputTokens":5}),
        })
    }
}
#[derive(Default)]
struct Calls(AtomicUsize);
#[async_trait]
impl Capabilities for Calls {
    async fn call(&self, _: &Channel, request: Request) -> Result<Value> {
        assert_eq!(request.id, "teams.update");
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"id":"00000000-0000-4000-8000-000000000001","slug":"forge","identifier":"FOR","name":"Changed","timezone":"Europe/Paris","description":"Fixture"}),
        )
    }
}
#[tokio::test]
async fn native_turn_restarts_on_a_new_connection_and_a_parked_lease_can_be_taken_by_approval() {
    let f = Fixture::new().await;
    let (old, mut state) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let calls = Arc::new(Calls::default());
    let engine = Engine::new(
        Arc::new(ModelFixture),
        Arc::new(Executor {
            capabilities: calls.clone(),
            sandbox: None,
            features: Features::default(),
        }),
    );
    assert_eq!(
        engine
            .drive(
                &f.channel,
                &mut state,
                &old,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    assert_eq!(calls.0.load(Ordering::SeqCst), 0);
    let request = state.pending_request().unwrap().to_owned();
    let second = Store::new(f.pool.clone());
    let (new, mut restored) = second
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    assert!(
        old.append(state.revision(), event(json!("old parked worker")))
            .await
            .is_err()
    );
    engine
        .resume(
            &f.channel,
            &mut restored,
            &new,
            &request,
            Decision::Approved,
        )
        .await
        .unwrap();
    assert_eq!(
        engine
            .drive(
                &f.channel,
                &mut restored,
                &new,
                &Cancellation::default(),
                Instant::now() + Duration::from_secs(10)
            )
            .await
            .unwrap(),
        Phase::Complete
    );
    assert_eq!(calls.0.load(Ordering::SeqCst), 1);
    new.release().await.unwrap();
    let (last, mut saved) = f
        .store
        .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(30))
        .await
        .unwrap();
    let before = f.store.load(&f.channel).await.unwrap().next_index;
    engine
        .drive(
            &f.channel,
            &mut saved,
            &last,
            &Cancellation::default(),
            Instant::now() + Duration::from_secs(10),
        )
        .await
        .unwrap();
    assert_eq!(calls.0.load(Ordering::SeqCst), 1);
    assert_eq!(f.store.load(&f.channel).await.unwrap().next_index, before);
}
