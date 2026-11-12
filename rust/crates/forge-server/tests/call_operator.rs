use async_trait::async_trait;
use forge_core::calls::providers::{Error, Summarizer};
use forge_server::call_providers::validate_operator;
use forge_store::{
    Database,
    calls::{Options, Service},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;
fn environment() -> HashMap<String, String> {
    HashMap::from([
        (
            "DATABASE_URL".into(),
            "postgres://fixture@127.0.0.1:9/fixture".into(),
        ),
        ("FORGE_ENVIRONMENT".into(), "development".into()),
        ("FORGE_CALLS_ENABLED".into(), "true".into()),
        ("FORGE_CALLS_PROVIDERS".into(), "google".into()),
        ("FORGE_GOOGLE_MEET_CLIENT_ID".into(), "fixture-id".into()),
        (
            "FORGE_GOOGLE_MEET_CLIENT_SECRET".into(),
            "private-secret".into(),
        ),
        ("BETTER_AUTH_URL".into(), "http://localhost:3000".into()),
        (
            "FORGE_MODEL_CREDENTIAL_KEK".into(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
        ),
        ("OPENAI_API_KEY".into(), "private-ai-key".into()),
    ])
}
fn command() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_forge-calls"));
    c.env_clear();
    if let Ok(path) = std::env::var("SSL_CERT_FILE") {
        c.env("SSL_CERT_FILE", path);
    }
    c
}
#[test]
fn calls_operator_requires_complete_explicit_configuration_and_redacts_errors() {
    let base = environment();
    assert!(validate_operator(&base).is_ok());
    for (key, value) in [
        ("FORGE_ENVIRONMENT", ""),
        ("FORGE_ENVIRONMENT", "staging"),
        ("FORGE_ENVIRONMENT", "production"),
        ("FORGE_CALLS_ENABLED", "false"),
        ("FORGE_CALLS_ENABLED", "yes"),
        ("FORGE_CALLS_PROVIDERS", ""),
        ("FORGE_CALLS_PROVIDERS", "other"),
        ("FORGE_GOOGLE_MEET_CLIENT_ID", " "),
        ("FORGE_GOOGLE_MEET_CLIENT_SECRET", ""),
        ("OPENAI_API_KEY", " "),
        ("FORGE_MODEL_CREDENTIAL_KEK", "bad"),
        ("BETTER_AUTH_URL", "https://private:secret@example.test"),
        ("BETTER_AUTH_URL", "https://example.test/path"),
        ("BETTER_AUTH_URL", "https://example.test/?secret=value"),
        ("BETTER_AUTH_URL", "file:///private"),
        ("NODE_ENV", "production"),
        ("AGENT_FAKE_RUNTIME_ENABLED", "yes"),
    ] {
        let mut env = base.clone();
        env.insert(key.into(), value.into());
        assert!(validate_operator(&env).is_err(), "{key}");
    }
    for args in [vec![], vec!["run", "--unknown"], vec!["sync"]] {
        let output = command().args(args).output().unwrap();
        assert!(!output.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":"INVALID_COMMAND"})
        );
        assert!(output.stdout.is_empty());
    }
    let output = command().arg("run").output().unwrap();
    assert!(!output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap(),
        json!({"code":"INVALID_CONFIGURATION"})
    );
}
#[tokio::test]
async fn calls_worker_isolates_failures_retries_recaps_and_operator_reports_durable_health() {
    let target =
        std::env::var("FORGE_RUST_CALLS_TEST_DATABASE_URL").expect("Run disposable milestone gate");
    let options: sqlx::postgres::PgConnectOptions = target.parse().unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert_eq!(options.get_username(), "forge_rust_test");
    assert_eq!(options.get_database(), Some("forge_rust_calls"));
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .unwrap();
    let database = Database::new(pool.clone());
    let workspace = Uuid::new_v4().to_string();
    let user = Uuid::new_v4().to_string();
    let session = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Calls operator',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Owner',$2,true)")
        .bind(&user)
        .bind(format!("{user}@example.test"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')")
        .bind(Uuid::new_v4().to_string())
        .bind(&workspace)
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,clock_timestamp()+interval '1 day')").bind(&session).bind(&user).bind(&workspace).execute(&pool).await.unwrap();
    let actor = forge_store::authority::session_actor(&database, &session)
        .await
        .unwrap();
    let team=forge_store::teams::create(&database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Calls","identifier":"COP","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    struct Summaries(AtomicBool);
    #[async_trait]
    impl Summarizer for Summaries {
        async fn summarize(&self, text: &str) -> Result<Value, Error> {
            if text.contains("Retry") && self.0.load(Ordering::SeqCst) {
                Err(Error)
            } else {
                Ok(json!({"summary":"Approved","decisions":[],"actions":[]}))
            }
        }
    }
    let summaries = Arc::new(Summaries(true.into()));
    let mut service = Service::new(
        database,
        Options {
            environment: environment(),
        },
    );
    service.summarizer = Some(summaries.clone());
    let mut ids = vec![];
    for text in ["Alex: Ready", "Alex: Retry", "Alex: Expired"] {
        ids.push(service.import(&actor,json!({"teamId":team.id,"title":"Review","startedAt":forge_core::loops::iso_timestamp(chrono::Utc::now()),"text":text,"consentConfirmed":true})).await.unwrap());
    }
    sqlx::query("UPDATE calls SET started_at=clock_timestamp()-interval '31 days' WHERE id=$1")
        .bind(ids[2])
        .execute(&pool)
        .await
        .unwrap();
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO call_connections(id,workspace_id,user_id,team_id,provider,secret) VALUES($1,$2,$3,$4,'google','invalid-private-envelope')").bind(connection).bind(&workspace).bind(&user).bind(team.id).execute(&pool).await.unwrap();
    let report = service.run().await.unwrap();
    assert_eq!(
        json!(report),
        json!({"imported":0,"expired":1,"summarized":1,"failures":2})
    );
    let failed:bool=sqlx::query_scalar("SELECT failed_at IS NOT NULL AND completed_at IS NULL FROM operational_job_health WHERE key='calls.sync'").fetch_one(&pool).await.unwrap();
    assert!(failed);
    sqlx::query("DELETE FROM call_connections WHERE id=$1")
        .bind(connection)
        .execute(&pool)
        .await
        .unwrap();
    summaries.0.store(false, Ordering::SeqCst);
    let report = service.run().await.unwrap();
    assert_eq!(
        json!(report),
        json!({"imported":0,"expired":0,"summarized":1,"failures":0})
    );
    let mut env = environment();
    env.insert("DATABASE_URL".into(), target);
    let output = command().arg("run").envs(&env).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"job":"calls.sync","report":{"imported":0,"expired":0,"summarized":0,"failures":0}})
    );
    let healthy: bool = sqlx::query_scalar(
        "SELECT completed_at>=failed_at FROM operational_job_health WHERE key='calls.sync'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(healthy);
    sqlx::query("INSERT INTO call_connections(id,workspace_id,user_id,team_id,provider,secret) VALUES($1,$2,$3,$4,'google','invalid-private-envelope')").bind(connection).bind(&workspace).bind(&user).bind(team.id).execute(&pool).await.unwrap();
    let output = command().arg("run").envs(env).output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["report"]["failures"],
        1
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private"));
    let failed: bool = sqlx::query_scalar(
        "SELECT failed_at>=completed_at FROM operational_job_health WHERE key='calls.sync'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(failed);
    pool.close().await;
}
