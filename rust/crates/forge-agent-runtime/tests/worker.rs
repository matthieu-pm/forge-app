use async_trait::async_trait;
use chrono::Utc;
use forge_agent_runtime::{
    Result,
    auth::Channel,
    callback::{Capabilities, Request},
    engine::{Decision, Engine, Phase, State},
    execution::Features,
    journal::Store,
    model::{
        stream::{Completion, Finish},
        transport::{Model, Sink, Turn},
    },
    sandbox::Cancellation,
    tools::Executor,
    worker::{Factory, Options, Response, Worker},
};
use forge_core::agents::tokens::{Kind, mint};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::Notify,
    time::{sleep, timeout},
};
use uuid::Uuid;
const SECRET: &str = "public-supervised-worker-fixture-secret";
fn channel(run: Uuid, issued: i64, ttl: f64, verified: i64) -> Channel {
    let token = mint(SECRET, Kind::RuntimeChannel, json!({"sub":"fixture-user","workspaceId":"fixture-workspace","runId":run,"forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-access-token","provider":"openai","modelId":"fixture-model","reasoningEffort":"medium"}), issued, ttl).unwrap();
    Channel::verify(SECRET, &format!("Bearer {token}"), verified).unwrap()
}
struct Fixture {
    pool: PgPool,
    store: Store,
    channel: Channel,
    run: Uuid,
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
        let channel = channel(run, Utc::now().timestamp(), 900., Utc::now().timestamp());
        let state = State::new(
            &channel,
            vec![json!({"role":"user","content":[{"type":"text","text":"Hello"}]})],
        )
        .unwrap();
        let store = Store::new(pool.clone());
        store
            .create(&channel, &state, Utc::now() + chrono::Duration::seconds(60))
            .await
            .unwrap();
        Self {
            pool,
            store,
            channel,
            run,
        }
    }
    fn worker(&self, factory: Arc<TestFactory>) -> Worker {
        Worker::new(
            self.store.clone(),
            factory,
            Options {
                lease_ttl: Duration::from_secs(1),
                heartbeat_interval: Duration::from_millis(150),
                database_timeout: Duration::from_millis(600),
            },
        )
        .unwrap()
    }
    async fn unleased(&self) {
        timeout(Duration::from_secs(5), async {
            loop {
                let free: bool = sqlx::query_scalar(
                    "SELECT lease_owner IS NULL FROM forge_runtime.sessions WHERE run_id=$1",
                )
                .bind(self.run)
                .fetch_one(&self.pool)
                .await
                .unwrap();
                if free {
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
#[derive(Clone, Copy)]
enum Behavior {
    Finish,
    Approve,
    Stall,
}
struct TestModel {
    behavior: Behavior,
    delay: Duration,
    started: Notify,
    active: AtomicUsize,
    calls: AtomicUsize,
}
struct Active<'a>(&'a AtomicUsize);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Model for TestModel {
    async fn generate(
        &self,
        _: &Channel,
        turn: Turn<'_>,
        _: &Cancellation,
        _: &mut dyn Sink,
    ) -> Result<Completion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(&self.active);
        self.started.notify_one();
        if matches!(self.behavior, Behavior::Stall) {
            std::future::pending::<()>().await;
        }
        sleep(self.delay).await;
        let approval = matches!(self.behavior, Behavior::Approve)
            && !turn.prompt.iter().any(|m| m["role"] == "tool");
        Ok(Completion {
            content: if approval {
                vec![
                    json!({"type":"tool-call","toolCallId":"change-team","toolName":"update_team","input":{"slug":"forge","settings":{"name":"Changed"}}}),
                ]
            } else {
                vec![json!({"type":"text","text":"Finished."})]
            },
            finish: if approval {
                Finish::ToolCalls
            } else {
                Finish::Stop
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
struct TestFactory {
    model: Arc<TestModel>,
    capabilities: Arc<Calls>,
    created: AtomicUsize,
    delay: Duration,
    started: Notify,
    cancellations: Mutex<Vec<Cancellation>>,
}
impl TestFactory {
    fn new(behavior: Behavior, delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            model: Arc::new(TestModel {
                behavior,
                delay,
                started: Notify::new(),
                active: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }),
            capabilities: Arc::new(Calls::default()),
            created: AtomicUsize::new(0),
            delay: Duration::ZERO,
            started: Notify::new(),
            cancellations: Mutex::new(vec![]),
        })
    }
}
#[async_trait]
impl Factory for TestFactory {
    async fn create(&self, _: &Channel, _: &State, cancellation: &Cancellation) -> Result<Engine> {
        self.created.fetch_add(1, Ordering::SeqCst);
        self.cancellations
            .lock()
            .unwrap()
            .push(cancellation.clone());
        self.started.notify_one();
        sleep(self.delay).await;
        Ok(Engine::new(
            self.model.clone(),
            Arc::new(Executor {
                capabilities: self.capabilities.clone(),
                sandbox: None,
                features: Features::default(),
            }),
        ))
    }
}
fn spawn(
    f: &Fixture,
    factory: Arc<TestFactory>,
    shutdown: Cancellation,
) -> tokio::task::JoinHandle<Result<Phase>> {
    let worker = f.worker(factory);
    let channel = f.channel.clone();
    tokio::spawn(async move { worker.run(&channel, None, &shutdown).await })
}
async fn started(factory: &TestFactory) {
    timeout(Duration::from_secs(5), factory.model.started.notified())
        .await
        .unwrap();
}

#[tokio::test]
async fn heartbeat_covers_factory_and_generation_and_a_second_worker_cannot_allocate_resources() {
    let f = Fixture::new().await;
    let mut factory = TestFactory::new(Behavior::Finish, Duration::from_millis(1300));
    Arc::get_mut(&mut factory).unwrap().delay = Duration::from_millis(1300);
    let handle = spawn(&f, factory.clone(), Cancellation::default());
    started(&factory).await; // Factory already exceeded the initial one-second lease.
    let contender = TestFactory::new(Behavior::Finish, Duration::ZERO);
    assert!(
        f.worker(contender.clone())
            .run(&f.channel, None, &Cancellation::default())
            .await
            .is_err()
    );
    assert_eq!(contender.created.load(Ordering::SeqCst), 0);
    sleep(Duration::from_millis(1050)).await;
    assert!(
        f.store
            .acquire(&f.channel, Uuid::new_v4(), Duration::from_secs(1))
            .await
            .is_err()
    );
    assert_eq!(handle.await.unwrap().unwrap(), Phase::Complete);
    f.unleased().await;
    let before = f.store.load(&f.channel).await.unwrap().next_index;
    assert_eq!(
        f.worker(contender.clone())
            .run(&f.channel, None, &Cancellation::default())
            .await
            .unwrap(),
        Phase::Complete
    );
    assert_eq!(contender.created.load(Ordering::SeqCst), 0);
    assert_eq!(f.store.load(&f.channel).await.unwrap().next_index, before);
}
#[tokio::test]
async fn cancellation_from_another_store_drops_inflight_work_and_preserves_the_terminal_events() {
    let f = Fixture::new().await;
    let factory = TestFactory::new(Behavior::Stall, Duration::ZERO);
    let handle = spawn(&f, factory.clone(), Cancellation::default());
    started(&factory).await;
    let other = Store::new(f.pool.clone());
    other.cancel(&f.channel).await.unwrap();
    let index = other.load(&f.channel).await.unwrap().next_index;
    assert!(
        timeout(Duration::from_secs(3), handle)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(factory.model.active.load(Ordering::SeqCst), 0);
    assert!(factory.cancellations.lock().unwrap()[0].is_cancelled());
    assert_eq!(other.load(&f.channel).await.unwrap().next_index, index);
    assert_eq!(
        other.events(&f.channel, index - 2, 2).await.unwrap()[0].value["type"],
        "turn.cancelled"
    );
    f.unleased().await;
}
#[tokio::test]
async fn aborted_worker_releases_its_lease_and_a_new_owner_recovers_the_checkpoint() {
    let f = Fixture::new().await;
    let factory = TestFactory::new(Behavior::Stall, Duration::ZERO);
    let handle = spawn(&f, factory.clone(), Cancellation::default());
    started(&factory).await;
    let revision = f.store.load(&f.channel).await.unwrap().state.revision();
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    f.unleased().await;
    assert_eq!(factory.model.active.load(Ordering::SeqCst), 0);
    assert!(factory.cancellations.lock().unwrap()[0].is_cancelled());
    let restarted = TestFactory::new(Behavior::Finish, Duration::ZERO);
    assert_eq!(
        f.worker(restarted)
            .run(&f.channel, None, &Cancellation::default())
            .await
            .unwrap(),
        Phase::Complete
    );
    assert!(f.store.load(&f.channel).await.unwrap().state.revision() > revision);
}
#[tokio::test]
async fn ownership_loss_and_shutdown_stop_model_work_without_marking_the_run_completed() {
    for revoke in [true, false] {
        let f = Fixture::new().await;
        let factory = TestFactory::new(Behavior::Stall, Duration::ZERO);
        let shutdown = Cancellation::default();
        let handle = spawn(&f, factory.clone(), shutdown.clone());
        started(&factory).await;
        if revoke {
            sqlx::query("UPDATE forge_runtime.sessions SET epoch=epoch+1,lease_owner=NULL,lease_until=NULL WHERE run_id=$1").bind(f.run).execute(&f.pool).await.unwrap();
        } else {
            shutdown.cancel();
        }
        assert!(
            timeout(Duration::from_secs(3), handle)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(factory.model.active.load(Ordering::SeqCst), 0);
        assert_eq!(
            f.store.load(&f.channel).await.unwrap().state.phase(),
            Phase::Generating
        );
        f.unleased().await;
    }
}
#[tokio::test]
async fn original_deadline_and_signed_credential_expiry_bound_even_silent_work() {
    for credential in [true, false] {
        let f = Fixture::new().await;
        let factory = TestFactory::new(Behavior::Stall, Duration::ZERO);
        let channel = if credential {
            let now = Utc::now().timestamp();
            let channel = channel(f.run, now - 29, 30., now);
            assert_eq!(channel.expires_at(), Some((now + 1) as f64));
            channel
        } else {
            sqlx::query("UPDATE forge_runtime.sessions SET deadline=clock_timestamp()+interval '500 milliseconds' WHERE run_id=$1").bind(f.run).execute(&f.pool).await.unwrap();
            f.channel.clone()
        };
        let result = timeout(
            Duration::from_secs(3),
            f.worker(factory.clone())
                .run(&channel, None, &Cancellation::default()),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(factory.model.active.load(Ordering::SeqCst), 0);
        f.unleased().await;
        assert_ne!(
            f.store.load(&f.channel).await.unwrap().state.phase(),
            Phase::Complete
        );
    }
}
#[tokio::test]
async fn expired_credentials_and_preexisting_shutdown_allocate_no_resources() {
    let f = Fixture::new().await;
    let factory = TestFactory::new(Behavior::Finish, Duration::ZERO);
    let now = Utc::now().timestamp();
    let expired = channel(f.run, now - 60, 30., now - 59); // Verified earlier, now expired.
    assert!(
        f.worker(factory.clone())
            .run(&expired, None, &Cancellation::default())
            .await
            .is_err()
    );
    let shutdown = Cancellation::default();
    shutdown.cancel();
    assert!(
        f.worker(factory.clone())
            .run(&f.channel, None, &shutdown)
            .await
            .is_err()
    );
    assert_eq!(factory.created.load(Ordering::SeqCst), 0);
    f.unleased().await;
}
#[tokio::test]
async fn approval_receipts_survive_completion_restarts_and_lost_acknowledgements() {
    let f = Fixture::new().await;
    let factory = TestFactory::new(Behavior::Approve, Duration::ZERO);
    let worker = f.worker(factory.clone());
    assert_eq!(
        worker
            .run(&f.channel, None, &Cancellation::default())
            .await
            .unwrap(),
        Phase::Waiting
    );
    let waiting = f.store.load(&f.channel).await.unwrap();
    let request = waiting.state.pending_request().unwrap().to_owned();
    assert_eq!(
        worker
            .run(&f.channel, None, &Cancellation::default())
            .await
            .unwrap(),
        Phase::Waiting
    );
    assert_eq!(factory.created.load(Ordering::SeqCst), 1);
    let response = || Response {
        request: request.clone(),
        decision: Decision::Approved,
    };
    assert_eq!(
        worker
            .run(&f.channel, Some(response()), &Cancellation::default())
            .await
            .unwrap(),
        Phase::Complete
    );
    let saved = f.store.load(&f.channel).await.unwrap();
    assert_eq!(saved.state.decision(&request), Some(Decision::Approved));
    assert_eq!(factory.capabilities.0.load(Ordering::SeqCst), 1);
    let fresh = TestFactory::new(Behavior::Approve, Duration::ZERO);
    assert_eq!(
        f.worker(fresh.clone())
            .run(&f.channel, Some(response()), &Cancellation::default())
            .await
            .unwrap(),
        Phase::Complete
    );
    for response in [
        Response {
            request: request.clone(),
            decision: Decision::Denied,
        },
        Response {
            request: Uuid::new_v4().to_string(),
            decision: Decision::Approved,
        },
    ] {
        assert!(
            f.worker(fresh.clone())
                .run(&f.channel, Some(response), &Cancellation::default())
                .await
                .is_err()
        );
    }
    assert_eq!(fresh.created.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.store.load(&f.channel).await.unwrap().next_index,
        saved.next_index
    );
}
#[tokio::test]
async fn invalid_heartbeat_configurations_are_rejected_before_work() {
    let f = Fixture::new().await;
    let factory = TestFactory::new(Behavior::Finish, Duration::ZERO);
    for options in [
        Options {
            lease_ttl: Duration::from_millis(999),
            ..Options::default()
        },
        Options {
            lease_ttl: Duration::from_secs(61),
            ..Options::default()
        },
        Options {
            heartbeat_interval: Duration::ZERO,
            ..Options::default()
        },
        Options {
            database_timeout: Duration::ZERO,
            ..Options::default()
        },
        Options {
            heartbeat_interval: Duration::from_secs(25),
            ..Options::default()
        },
    ] {
        assert!(Worker::new(f.store.clone(), factory.clone(), options).is_err());
    }
}
