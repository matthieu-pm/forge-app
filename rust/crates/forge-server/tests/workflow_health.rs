use chrono::{DateTime, Duration, Utc};
use forge_core::workflow_health::{Code, Run};
use forge_store::{
    Database,
    jobs::{Enqueue, JobStore},
    operational_health,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{collections::BTreeMap, process::Command};
use uuid::Uuid;

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_forge-health"));
    command.env_clear();
    command
}
#[test]
fn health_worker_requires_explicit_target_and_a_known_check() {
    for args in [vec![], vec!["unknown"], vec!["workflows", "extra"]] {
        let output = command().args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":"INVALID_COMMAND"})
        );
    }
    let output = command().arg("workflows").output().unwrap();
    assert!(!output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap(),
        json!({"code":"INVALID_CONFIGURATION"})
    );
}
async fn heartbeat(pool: &PgPool) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    sqlx::query_as(
        "SELECT completed_at,failed_at FROM operational_job_health WHERE key='workflow.health'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn insert(pool: &PgPool, run: &Run) {
    sqlx::query("INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key,sdk_run_id,state,created_at,started_at) VALUES($1,$2,$3,'invitation',$1::text,$1::text,$4,$5,$6,$7)")
        .bind(run.id).bind(&run.workspace_id).bind(&run.kind).bind(&run.sdk_run_id).bind(&run.state).bind(run.created_at).bind(run.started_at).execute(pool).await.unwrap();
    for (key, effect) in [("initial", &run.initial), ("reminder-24h", &run.reminder)] {
        if let Some(effect) = effect {
            sqlx::query("INSERT INTO business_workflow_effects(business_run_id,effect_key,state,completed_at) VALUES($1,$2,$3,$4)")
                .bind(run.id).bind(format!("workspace-invitation:{}:{key}:v1",run.id)).bind(&effect.state).bind(effect.completed_at).execute(pool).await.unwrap();
        }
    }
}

#[tokio::test]
async fn real_health_check_preserves_source_rules_reports_native_stalls_and_bounds_operational_output()
 {
    let url = std::env::var("FORGE_RUST_HEALTH_TEST_DATABASE_URL")
        .expect("Run the disposable milestone gate");
    let options: sqlx::postgres::PgConnectOptions = url.parse().unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert_eq!(options.get_database(), Some("forge_rust_health"));
    assert_eq!(options.get_username(), "forge_rust_test");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .unwrap();
    let database = Database::new(pool.clone());
    let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    assert!(
        operational_health::workflows(&database, now)
            .await
            .unwrap()
            .successful()
    );
    let successful = heartbeat(&pool).await;
    assert!(successful.0.is_some());
    assert!(successful.1.is_none());
    let workspace = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'private-workspace-name',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../forge-core/data/workflow-health-reference.json"
    ))
    .unwrap();
    let mut expected = BTreeMap::new();
    let mut missing = 0;
    for fixture in fixtures {
        let mut run: Run = serde_json::from_value(fixture["input"].clone()).unwrap();
        let origin: DateTime<Utc> = fixture["now"].as_str().unwrap().parse().unwrap();
        let offset = now - origin;
        run.id = Uuid::new_v4();
        run.workspace_id = workspace.clone();
        run.sdk_run_id = run
            .sdk_run_id
            .map(|_| format!("private-sdk-owner:{}", run.id));
        run.created_at += offset;
        run.started_at = run.started_at.map(|at| at + offset);
        for effect in [&mut run.initial, &mut run.reminder].into_iter().flatten() {
            effect.completed_at = effect.completed_at.map(|at| at + offset);
        }
        insert(&pool, &run).await;
        if !fixture["code"].is_null() {
            expected.insert(run.id, fixture["code"].clone());
        }
        missing += fixture["count"].as_u64().unwrap() as usize;
    }
    let store = JobStore::new(database.clone());
    for (state, age, lease, code) in [
        ("queued", 300000, None, Some(Code::NativeJobOverdue)),
        ("retry", 299999, None, None),
        ("running", 0, Some(0), Some(Code::NativeLeaseExpired)),
        ("running", 0, Some(1), None),
        ("dead", 0, None, Some(Code::NativeJobFailed)),
        ("reconcile", 0, None, Some(Code::NativeJobFailed)),
        ("completed", 0, None, Some(Code::NativeStateMismatch)),
        ("queued", -86400000, None, None),
        ("missing", 0, None, Some(Code::NativeJobMissing)),
    ] {
        let id = Uuid::new_v4();
        let job = if state == "missing" {
            Uuid::new_v4()
        } else {
            let job = store
                .enqueue(&Enqueue {
                    kind: "workspace-invitation-lifecycle-v1".into(),
                    scope: workspace.clone(),
                    identity: id.to_string(),
                    input: json!({"private":"private-job-input"}),
                    scheduled_at: now - Duration::milliseconds(age),
                    max_attempts: 5,
                })
                .await
                .unwrap();
            sqlx::query("UPDATE background_jobs SET state=$2,lease_token=$3,lease_until=$4,completed_at=$5 WHERE id=$1")
                .bind(job).bind(state).bind((state=="running").then(Uuid::new_v4)).bind(lease.map(|ms|now+Duration::milliseconds(ms))).bind((state=="completed").then_some(now)).execute(&pool).await.unwrap();
            job
        };
        let run = Run {
            id,
            workspace_id: workspace.clone(),
            kind: "workspace-invitation-lifecycle-v1".into(),
            state: "queued".into(),
            sdk_run_id: Some(format!("forge-native-job:{job}")),
            created_at: now,
            started_at: None,
            initial: None,
            reminder: None,
            job: None,
        };
        insert(&pool, &run).await;
        if let Some(code) = code {
            expected.insert(id, json!(code));
        }
    }
    let report = operational_health::workflows(&database, now).await.unwrap();
    assert_eq!(report.count, missing);
    assert_eq!(report.failures, expected.len());
    assert_eq!(report.omitted, 0);
    let actual = report
        .issues
        .iter()
        .map(|issue| (issue.business_run_id, json!(issue.code)))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(actual, expected);
    let failed = heartbeat(&pool).await;
    assert_eq!(failed.0, successful.0);
    assert!(failed.1.is_some());
    sqlx::query("INSERT INTO business_workflow_runs(workspace_id,kind,subject_type,subject_id,idempotency_key,state) SELECT $1,'fixture','fixture','bulk-'||n,'health-bulk-'||n,'failed' FROM generate_series(1,1005) n")
        .bind(&workspace).execute(&pool).await.unwrap();
    let report = operational_health::workflows(&database, now).await.unwrap();
    assert_eq!(report.failures, expected.len() + 1005);
    assert_eq!(report.issues.len(), 1000);
    assert_eq!(report.omitted, report.failures - 1000);
    let output = command()
        .arg("workflows")
        .env("DATABASE_URL", &url)
        .env("FORGE_ENVIRONMENT", "development")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let serialized = String::from_utf8(output.stdout).unwrap();
    assert!(!serialized.contains("private-job-input"));
    assert!(!serialized.contains("private-sdk-owner"));
    assert!(!serialized.contains("private-workspace-name"));
    let output: Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(output["job"], "workflow.health");
    assert_eq!(output["report"]["issues"].as_array().unwrap().len(), 1000);
    // Successful freshness advances only after all failing runs are resolved.
    sqlx::query("UPDATE business_workflow_runs SET state='completed'")
        .execute(&pool)
        .await
        .unwrap();
    let prior = heartbeat(&pool).await;
    let output = command()
        .arg("workflows")
        .env("DATABASE_URL", &url)
        .env("FORGE_ENVIRONMENT", "development")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let clean = heartbeat(&pool).await;
    assert!(clean.0 > prior.0);
    assert_eq!(clean.1, prior.1);
    // A failed query must not publish a successful heartbeat or leak SQL.
    sqlx::query("ALTER TABLE business_workflow_effects RENAME TO health_fixture_effects")
        .execute(&pool)
        .await
        .unwrap();
    let output = command()
        .arg("workflows")
        .env("DATABASE_URL", &url)
        .env("FORGE_ENVIRONMENT", "development")
        .output()
        .unwrap();
    sqlx::query("ALTER TABLE health_fixture_effects RENAME TO business_workflow_effects")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap(),
        json!({"code":"WORKFLOW_HEALTH_FAILED"})
    );
    let query_failure = heartbeat(&pool).await;
    assert_eq!(query_failure.0, clean.0);
    assert!(query_failure.1 > clean.1);
}
