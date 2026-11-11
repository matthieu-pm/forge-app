use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_store::jobs::{
    self, Code, Enqueue, Error, ExternalPolicy, JobStore, Lease, Recovery, State, runner,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn input(f: &Fixture, attempts: i32) -> Enqueue {
    Enqueue {
        kind: format!("fixture:{}", Uuid::new_v4()),
        scope: f.actor.workspace_id.clone(),
        identity: Uuid::new_v4().to_string(),
        input: json!({"workspace":f.actor.workspace_id,"secret":"private-input"}),
        scheduled_at: "2020-01-01T00:00:00Z".parse().unwrap(),
        max_attempts: attempts,
    }
}
async fn enqueue(f: &Fixture, attempts: i32) -> (JobStore, Enqueue, Uuid) {
    let store = JobStore::new(f.database.clone());
    let input = input(f, attempts);
    let id = store.enqueue(&input).await.unwrap();
    (store, input, id)
}
async fn due(f: &Fixture, id: Uuid) {
    sqlx::query(
        "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
}
async fn expire(f: &Fixture, store: &JobStore, id: Uuid) {
    sqlx::query("UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND state='running'").bind(id).execute(&f.pool).await.unwrap();
    store.reap(None, Some(id)).await.unwrap();
    due(f, id).await;
}
async fn recovery(store: &JobStore, id: Uuid) -> Value {
    let inspected = store.inspect(Some(id)).await.unwrap();
    json!({"requestId":Uuid::new_v4(),"jobId":id,"operatorId":Uuid::new_v4(),"generation":inspected["jobs"][0]["generation"],"reason":"code-fixed","action":"replay"})
}
fn code<T: std::fmt::Debug>(result: jobs::Result<T>, expected: Code) {
    assert_eq!(result.unwrap_err().code, expected);
}
async fn effect(tx: &mut PgConnection, id: Uuid, workspace: &str) -> jobs::Result<Value> {
    sqlx::query("INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key) VALUES($1,$2,'fixture','fixture',$1::text,$1::text)").bind(id).bind(workspace).execute(tx).await.map_err(|_|Error::from(Code::JobFailed))?;
    Ok(json!({"count":1,"secret":"private-result"}))
}
async fn count(f: &Fixture, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM business_workflow_runs WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn job_enqueue_and_claim_are_concurrent_and_identity_is_immutable() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 5).await;
    let copies = futures_util::future::join_all((0..8).map(|_| store.enqueue(&input))).await;
    assert!(copies.into_iter().all(|r| r.unwrap() == id));
    for variant in 0..3 {
        let mut changed = input.clone();
        match variant {
            0 => changed.input["secret"] = json!("different"),
            1 => changed.scheduled_at += Duration::seconds(1),
            _ => changed.max_attempts = 4,
        };
        code(store.enqueue(&changed).await, Code::IdentityConflict);
    }
    let claims =
        futures_util::future::join_all((0..8).map(|_| store.claim(&input.kind, Some(id)))).await;
    let leases: Vec<_> = claims.into_iter().filter_map(|r| r.unwrap()).collect();
    assert_eq!(leases.len(), 1);
    let lease = &leases[0];
    assert_eq!((lease.generation, lease.attempt), (1, 1));
    assert_eq!(lease.input, input.input);
    assert!(lease.queue_age_ms > 0.);
    store.complete(lease).await.unwrap();
    assert!(store.claim(&input.kind, Some(id)).await.unwrap().is_none());
    let mut future = input.clone();
    future.identity = Uuid::new_v4().to_string();
    future.scheduled_at = "2100-01-01T00:00:00Z".parse().unwrap();
    let future = store.enqueue(&future).await.unwrap();
    assert!(
        store
            .claim(&input.kind, Some(future))
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn lease_takeover_fences_every_write_and_preserves_checkpoints() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 5).await;
    let old = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    let workspace = f.actor.workspace_id.clone();
    let first = store
        .sql_step(&old, "effect", move |tx| {
            Box::pin(async move { effect(tx, id, &workspace).await })
        })
        .await
        .unwrap();
    expire(&f, &store, id).await;
    let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    assert_eq!(lease.generation, old.generation + 1);
    code(store.heartbeat(&old).await, Code::LeaseLost);
    code(store.complete(&old).await, Code::LeaseLost);
    code(store.defer(&old).await, Code::LeaseLost);
    code(
        store.fail(&old, Code::JobFailed.into()).await,
        Code::LeaseLost,
    );
    code(
        store
            .sql_step(&old, "other", |_| {
                Box::pin(async { panic!("old worker executed") })
            })
            .await,
        Code::LeaseLost,
    );
    code(
        store
            .external_step(&old, "external", ExternalPolicy::Reconcile, |_, _| async {
                panic!("old provider invoked")
            })
            .await,
        Code::LeaseLost,
    );
    assert_eq!(
        store
            .sql_step(&lease, "effect", |_| Box::pin(async {
                panic!("committed effect repeated")
            }))
            .await
            .unwrap(),
        first
    );
    code(
        store
            .external_step(&lease, "effect", ExternalPolicy::Reconcile, |_, _| async {
                panic!()
            })
            .await,
        Code::IdentityConflict,
    );
    store.complete(&lease).await.unwrap();
    assert_eq!(count(&f, id).await, 1);
}
#[tokio::test]
async fn sql_step_rolls_back_failure_oversize_and_expired_commit() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 5).await;
    let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    for scenario in 0..3 {
        let workspace = f.actor.workspace_id.clone();
        let result=store.sql_step(&lease,"effect",move |tx|Box::pin(async move {
            effect(tx,id,&workspace).await?;
            match scenario { 0=>Err(Code::JobFailed.into()),1=>Ok(json!("x".repeat(16385))),_=>{
                sqlx::query("UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1").bind(id).execute(tx).await.map_err(|_|Error::from(Code::JobFailed))?; Ok(Value::Null)
            }}
        })).await;
        code(
            result,
            [Code::JobFailed, Code::InvalidInput, Code::LeaseLost][scenario],
        );
        assert_eq!(count(&f, id).await, 0);
        assert_eq!(store.inspect(Some(id)).await.unwrap()["steps"], json!([]));
    }
    store.complete(&lease).await.unwrap();
}

struct EffectHandler {
    fail: bool,
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl runner::Handler for EffectHandler {
    async fn run(&self, store: &JobStore, lease: &Lease) -> Result<(), runner::RunError> {
        let workspace = lease.input["workspace"].as_str().unwrap().to_owned();
        let id = lease.id;
        let calls = self.calls.clone();
        store
            .sql_step(lease, "effect", move |tx| {
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    effect(tx, id, &workspace).await
                })
            })
            .await?;
        if self.fail {
            Err(Error::from(Code::JobFailed).into())
        } else {
            Ok(())
        }
    }
}
#[derive(Default)]
struct Events(Mutex<Vec<Value>>);
impl runner::Observer for Events {
    fn event(&self, name: &'static str, data: Value) {
        self.0
            .lock()
            .unwrap()
            .push(json!({"name":name,"data":data}));
    }
}
#[tokio::test]
async fn retries_stop_and_recovery_reuses_identity_and_redacts_inspection() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 2).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let mut handler = EffectHandler {
        fail: true,
        calls: calls.clone(),
    };
    let events = Events::default();
    assert_eq!(
        runner::run_observed(&store, &input.kind, &handler, Some(id), &events)
            .await
            .unwrap()["state"],
        "retry"
    );
    assert!(store.claim(&input.kind, Some(id)).await.unwrap().is_none());
    due(&f, id).await;
    assert_eq!(
        runner::run_observed(&store, &input.kind, &handler, Some(id), &events)
            .await
            .unwrap()["state"],
        "dead"
    );
    let inspection = jobs::cli::command(&store, &["inspect".into(), id.to_string()], Utc::now())
        .await
        .unwrap();
    assert!(!inspection.to_string().contains("private-"));
    assert!(
        inspection["recovery"][0]["command"]
            .as_str()
            .unwrap()
            .contains("forge-jobs")
    );
    assert!(
        !json!(*events.0.lock().unwrap())
            .to_string()
            .contains("private-")
    );
    let raw = recovery(&store, id).await;
    let r = Recovery::parse(raw.clone()).unwrap();
    assert_eq!(store.recover(&r).await.unwrap(), json!({"replayed":false}));
    assert_eq!(store.recover(&r).await.unwrap(), json!({"replayed":true}));
    let mut changed = raw.clone();
    changed["reason"] = json!("dependency-restored");
    code(
        store.recover(&Recovery::parse(changed).unwrap()).await,
        Code::RecoveryConflict,
    );
    let mut changed = raw;
    changed["requestId"] = json!(Uuid::new_v4());
    code(
        store.recover(&Recovery::parse(changed).unwrap()).await,
        Code::RecoveryConflict,
    );
    handler.fail = false;
    assert_eq!(
        runner::run_next(&store, &input.kind, &handler, Some(id))
            .await
            .unwrap()["state"],
        "completed"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(count(&f, id).await, 1);
    let job = &store.inspect(Some(id)).await.unwrap()["jobs"][0];
    assert_eq!(job["total_attempts"], 3);
    assert_eq!(job["attempts"], 1);
}
#[tokio::test]
async fn ambiguous_external_steps_require_evidence_and_separate_replay() {
    let f = Fixture::new().await;
    for completed in [true, false] {
        let (store, input, id) = enqueue(&f, 1).await;
        let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
        code(
            store
                .external_step(
                    &lease,
                    "send",
                    ExternalPolicy::Reconcile,
                    |_, deadline| async move {
                        assert!(deadline.is_none());
                        Err(Code::JobFailed.into())
                    },
                )
                .await,
            Code::JobFailed,
        );
        code(
            store
                .external_step(&lease, "send", ExternalPolicy::Reconcile, |_, _| async {
                    panic!("ambiguous effect repeated")
                })
                .await,
            Code::ReconciliationRequired,
        );
        code(store.complete(&lease).await, Code::ReconciliationRequired);
        expire(&f, &store, id).await;
        assert_eq!(
            store.inspect(Some(id)).await.unwrap()["jobs"][0]["state"],
            "reconcile"
        );
        let mut raw = recovery(&store, id).await;
        code(
            store.recover(&Recovery::parse(raw.clone()).unwrap()).await,
            Code::ReconciliationRequired,
        );
        raw["action"] = json!("resolve");
        raw["reason"] = json!("provider-confirmed");
        raw["step"] = json!("send");
        raw["outcome"] = json!(if completed { "completed" } else { "retry-safe" });
        raw["quiesced"] = json!(true);
        raw["evidence"] = json!("FOR-64");
        store
            .recover(&Recovery::parse(raw.clone()).unwrap())
            .await
            .unwrap();
        let audit:(String,bool,String)=sqlx::query_as("SELECT evidence,quiesced,database_role FROM background_job_recoveries WHERE request_id=$1").bind(raw["requestId"].as_str().unwrap().parse::<Uuid>().unwrap()).fetch_one(&f.pool).await.unwrap();
        assert_eq!(audit, ("FOR-64".into(), true, "forge_rust_test".into()));
        assert!(store.claim(&input.kind, Some(id)).await.unwrap().is_none());
        store
            .recover(&Recovery::parse(recovery(&store, id).await).unwrap())
            .await
            .unwrap();
        let next = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
        let calls = AtomicUsize::new(0);
        store
            .external_step(&next, "send", ExternalPolicy::Reconcile, |_, _| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(!completed));
        store.complete(&next).await.unwrap();
    }
}
#[tokio::test]
async fn provider_retry_preserves_key_and_original_deduplication_deadline() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 5).await;
    let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    let deadline: DateTime<Utc> = "2100-01-01T00:00:00Z".parse().unwrap();
    let observations = Mutex::new(Vec::new());
    let observed = &observations;
    code(
        store
            .external_step(
                &lease,
                "send",
                ExternalPolicy::ProviderIdempotent {
                    valid_until: deadline,
                },
                |key, at| async move {
                    observed.lock().unwrap().push((key, at));
                    Err(Code::JobFailed.into())
                },
            )
            .await,
        Code::JobFailed,
    );
    assert_eq!(
        store.fail(&lease, Code::JobFailed.into()).await.unwrap(),
        State::Retry
    );
    due(&f, id).await;
    let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    code(
        store
            .external_step(
                &lease,
                "send",
                ExternalPolicy::ProviderIdempotent {
                    valid_until: deadline + Duration::days(1),
                },
                |key, at| async move {
                    observed.lock().unwrap().push((key, at));
                    Err(Code::JobFailed.into())
                },
            )
            .await,
        Code::JobFailed,
    );
    {
        let values = observed.lock().unwrap();
        assert_eq!(values[0], values[1]);
        assert_eq!(values[0].1, Some(deadline));
    }
    sqlx::query("UPDATE background_job_steps SET idempotency_until=clock_timestamp()-interval '1 second' WHERE job_id=$1").bind(id).execute(&f.pool).await.unwrap();
    code(
        store
            .external_step(
                &lease,
                "send",
                ExternalPolicy::ProviderIdempotent {
                    valid_until: deadline,
                },
                |_, _| async { panic!("expired provider promise reused") },
            )
            .await,
        Code::ReconciliationRequired,
    );
    assert_eq!(
        store
            .fail(&lease, Error::permanent(Code::JobFailed))
            .await
            .unwrap(),
        State::Reconcile
    );
}

struct Deferred(bool);
#[async_trait]
impl runner::Handler for Deferred {
    async fn run(&self, store: &JobStore, lease: &Lease) -> Result<(), runner::RunError> {
        if self.0 {
            store.complete(lease).await?;
        }
        Err(runner::RunError::Deferred)
    }
}
#[tokio::test]
async fn deferral_does_not_burn_attempts_or_override_lost_ownership() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 1).await;
    assert_eq!(
        runner::run_next(&store, &input.kind, &Deferred(false), Some(id))
            .await
            .unwrap()["state"],
        "deferred"
    );
    let job = &store.inspect(Some(id)).await.unwrap()["jobs"][0];
    assert_eq!(job["attempts"], 0);
    assert_eq!(job["total_attempts"], 1);
    assert_eq!(job["state"], "queued");
    assert!(store.claim(&input.kind, Some(id)).await.unwrap().is_none());
    due(&f, id).await;
    assert_eq!(
        runner::run_next(&store, &input.kind, &Deferred(true), Some(id))
            .await
            .unwrap()["state"],
        "lost"
    );
    assert_eq!(
        store.inspect(Some(id)).await.unwrap()["jobs"][0]["state"],
        "completed"
    );
}
#[tokio::test]
async fn competing_recoveries_serialize_and_id_claim_does_not_reap_other_jobs() {
    let f = Fixture::new().await;
    let (store, input, id) = enqueue(&f, 1).await;
    let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    assert_eq!(
        store.fail(&lease, Code::JobFailed.into()).await.unwrap(),
        State::Dead
    );
    let raw = recovery(&store, id).await;
    let a = Recovery::parse(raw.clone()).unwrap();
    let mut other = raw;
    other["requestId"] = json!(Uuid::new_v4());
    let b = Recovery::parse(other).unwrap();
    let (a, b) = tokio::join!(store.recover(&a), store.recover(&b));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
    sqlx::query(
        "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(
        store
            .claim(&input.kind, Some(Uuid::new_v4()))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.inspect(Some(id)).await.unwrap()["jobs"][0]["state"],
        "running"
    );
    code(store.heartbeat(&lease).await, Code::LeaseLost);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_process_boundary() {
    use std::{
        io::{BufRead, Write},
        process::{Command, Stdio},
    };
    // This same test executable becomes the isolated crash worker. The parent
    // exercises both commit boundaries and always kills/reaps its child.
    if let Ok(id) = std::env::var("FORGE_RUST_JOB_WORKER_ID") {
        let id: Uuid = id.parse().unwrap();
        let phase = std::env::var("FORGE_RUST_JOB_WORKER_PHASE").unwrap();
        let connection = std::env::var("FORGE_RUST_TEST_DATABASE_URL").unwrap();
        let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(3)
            .connect_with(options)
            .await
            .unwrap();
        let kind: String = sqlx::query_scalar("SELECT kind FROM background_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let store = JobStore::new(forge_store::Database::new(pool));
        let lease = store.claim(&kind, Some(id)).await.unwrap().unwrap();
        let workspace = lease.input["workspace"].as_str().unwrap().to_owned();
        let before = phase == "before";
        store
            .sql_step(&lease, "effect", move |tx| {
                Box::pin(async move {
                    let result = effect(tx, id, &workspace).await?;
                    if before {
                        println!("FORGE_JOB_BOUNDARY");
                        std::io::stdout().flush().unwrap();
                        std::future::pending::<()>().await;
                    }
                    Ok(result)
                })
            })
            .await
            .unwrap();
        println!("FORGE_JOB_BOUNDARY");
        std::io::stdout().flush().unwrap();
        std::future::pending::<()>().await;
        unreachable!();
    }
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let f = Fixture::new().await;
    for phase in ["before", "after"] {
        let (store, input, id) = enqueue(&f, 5).await;
        let mut child = Child(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "job_acceptance::job_process_boundary",
                    "--nocapture",
                ])
                .env("FORGE_RUST_JOB_WORKER_ID", id.to_string())
                .env("FORGE_RUST_JOB_WORKER_PHASE", phase)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::task::spawn_blocking(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if line.contains("FORGE_JOB_BOUNDARY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let observed = tokio::time::timeout(std::time::Duration::from_secs(15), rx).await;
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(
            matches!(observed, Ok(Ok(()))),
            "worker did not reach {phase} boundary"
        );
        expire(&f, &store, id).await;
        let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
        let workspace = f.actor.workspace_id.clone();
        let result = store
            .sql_step(&lease, "effect", move |tx| {
                Box::pin(async move { effect(tx, id, &workspace).await })
            })
            .await
            .unwrap();
        assert_eq!(result["count"], 1);
        store.complete(&lease).await.unwrap();
        assert_eq!(count(&f, id).await, 1);
    }
}

#[tokio::test]
async fn workflow_retention_batches_only_old_terminal_records_and_freezes_cutoff() {
    let f = Fixture::new().await;
    let store = JobStore::new(f.database.clone());
    // Very old isolated day avoids races with the other workflow fixtures.
    let now: DateTime<Utc> = "1901-04-01T12:00:00Z".parse().unwrap();
    let ids:Vec<Uuid>=sqlx::query_scalar("INSERT INTO business_workflow_runs(workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at,updated_at) SELECT $1,'fixture','fixture',gen_random_uuid()::text,gen_random_uuid()::text,CASE WHEN n=502 THEN 'running' WHEN n=503 THEN 'failed-to-start' ELSE 'completed' END,CASE WHEN n=501 THEN '1901-03-31'::timestamptz ELSE '1900-01-01'::timestamptz END,CASE WHEN n=501 THEN '1901-03-31'::timestamptz ELSE '1900-01-01'::timestamptz END FROM generate_series(0,503) n RETURNING id").bind(&f.actor.workspace_id).fetch_all(&f.pool).await.unwrap();
    let id = jobs::retention::enqueue(&store, now).await.unwrap();
    assert_eq!(
        jobs::retention::enqueue(&store, now + Duration::hours(8))
            .await
            .unwrap(),
        id
    );
    let lease = store
        .claim(jobs::retention::KIND, Some(id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.input["cutoff"], "1901-01-01T00:00:00.000Z");
    runner::Handler::run(&jobs::retention::WorkflowRetention, &store, &lease)
        .await
        .unwrap();
    store.complete(&lease).await.unwrap();
    let remaining: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM business_workflow_runs WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(remaining.len(), 2);
    assert!(remaining.contains(&ids[501]));
    assert!(remaining.contains(&ids[502]));
    assert_eq!(
        store.inspect(Some(id)).await.unwrap()["steps"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    jobs::retention::run(&store, now).await.unwrap();
    // Failed daily identity cannot be disguised as a successful cleanup tick.
    let next = now + Duration::days(1);
    let id = jobs::retention::enqueue(&store, next).await.unwrap();
    let lease = store
        .claim(jobs::retention::KIND, Some(id))
        .await
        .unwrap()
        .unwrap();
    store
        .fail(&lease, Error::permanent(Code::InvalidInput))
        .await
        .unwrap();
    code(jobs::retention::run(&store, next).await, Code::JobFailed);
}

#[tokio::test]
async fn delayed_intent_and_completion_recheck_lease_after_lock_waits() {
    let f = Fixture::new().await;
    for external in [false, true] {
        let (store, input, id) = enqueue(&f, 5).await;
        let lease = store.claim(&input.kind, Some(id)).await.unwrap().unwrap();
        let mut block = f.pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE background_job_steps IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *block)
            .await
            .unwrap();
        sqlx::query("UPDATE background_jobs SET lease_until=clock_timestamp()+interval '400 milliseconds' WHERE id=$1").bind(id).execute(&f.pool).await.unwrap();
        let store = store.clone();
        let pending = tokio::spawn(async move {
            if external {
                store
                    .external_step(&lease, "late", ExternalPolicy::Reconcile, |_, _| async {
                        panic!("provider invoked after lease expiry")
                    })
                    .await
            } else {
                store.complete(&lease).await
            }
        });
        // Hold a real database lock past expiry; this is a bounded acceptance
        // barrier, not a production timer or a mocked ownership check.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        block.commit().await.unwrap();
        code(pending.await.unwrap(), Code::LeaseLost);
    }
}
