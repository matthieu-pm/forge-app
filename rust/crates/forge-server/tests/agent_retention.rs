use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("forge-retention-fixture-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn command(root: &Path, url: Option<&str>, args: &[&str]) -> std::process::Output {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_forge-retention"));
    command
        .env_clear()
        .current_dir(root)
        .args(args)
        .kill_on_drop(true);
    if let Some(url) = url {
        command
            .env("DATABASE_URL", url)
            .env("FORGE_ENVIRONMENT", "development")
            .env("FORGE_AGENT_ARTIFACT_DIRECTORY", root)
            .env("FORGE_RECOVERY_JOURNAL_ENABLED", "false");
    }
    tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .unwrap()
        .unwrap()
}
async fn report(root: &Path, url: &str, success: bool, count: usize, failures: usize) {
    let output = command(root, Some(url), &["agent"]).await;
    assert_eq!(
        output.status.success(),
        success,
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"job":"agent.retention","count":count,"failures":failures})
    );
}
async fn heartbeat(pool: &PgPool) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    sqlx::query_as(
        "SELECT completed_at,failed_at FROM operational_job_health WHERE key='agent.retention'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn bytes(root: &Path, reference: &str) {
    let path = root.join(reference);
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(path, b"private fixture content")
        .await
        .unwrap();
}
#[test]
fn operator_targets_are_explicit_and_do_not_downgrade_deployed_processes() {
    let valid = HashMap::from([
        (
            "DATABASE_URL".into(),
            "postgresql://fixture@127.0.0.1/fixture".into(),
        ),
        ("FORGE_ENVIRONMENT".into(), "development".into()),
    ]);
    assert!(forge_server::operator::database_url(&valid).is_ok());
    for (key, value) in [
        ("DATABASE_URL", ""),
        ("DATABASE_URL", "https://private:credential@example.test/db"),
        ("DATABASE_URL", "postgresql://localhost/"),
        ("FORGE_ENVIRONMENT", ""),
        ("FORGE_ENVIRONMENT", "unknown"),
        ("NODE_ENV", "production"),
        ("VERCEL_ENV", "production"),
        ("FORGE_FEATURE_ROLLOUTS", "invalid"),
        ("AGENT_FAKE_RUNTIME_ENABLED", "yes"),
        ("EVE_EVAL_FIXTURE_MODE", "1"),
    ] {
        let mut env = valid.clone();
        env.insert(key.into(), value.into());
        assert_eq!(
            forge_server::operator::database_url(&env),
            Err("INVALID_CONFIGURATION")
        );
    }
    for key in ["DATABASE_URL", "FORGE_ENVIRONMENT"] {
        let mut env = valid.clone();
        env.remove(key);
        assert!(forge_server::operator::database_url(&env).is_err());
    }
    for environment in ["staging", "production"] {
        let mut env = valid.clone();
        env.insert("FORGE_ENVIRONMENT".into(), environment.into());
        assert!(forge_server::operator::database_url(&env).is_ok());
        for key in ["AGENT_FAKE_RUNTIME_ENABLED", "EVE_EVAL_FIXTURE_MODE"] {
            env.insert(key.into(), "true".into());
            assert!(forge_server::operator::database_url(&env).is_err());
            env.remove(key);
        }
    }
}
#[tokio::test]
async fn retention_executable_rejects_unknown_commands_and_never_loads_dotenv() {
    let root = Directory::new();
    for name in [".env", ".env.local"] {
        tokio::fs::write(root.0.join(name),"DATABASE_URL=postgresql://private-fixture:private-password@forbidden.invalid/never\nFORGE_ENVIRONMENT=development\n").await.unwrap();
    }
    for (args, code) in [
        (&[][..], "INVALID_COMMAND"),
        (&["agent", "unexpected"][..], "INVALID_COMMAND"),
        (&["product"][..], "INVALID_COMMAND"),
        (&["agent"][..], "INVALID_CONFIGURATION"),
    ] {
        let output = command(&root.0, None, args).await;
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":code})
        );
    }
}
#[tokio::test]
async fn actual_agent_retention_process_records_failures_retries_and_quarantines_recent_uploads() {
    let url = std::env::var("FORGE_RUST_AGENT_RETENTION_TEST_DATABASE_URL")
        .expect("Use the disposable PostgreSQL milestone runner");
    let parsed = url::Url::parse(&url).unwrap();
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert_eq!(parsed.path(), "/forge_rust_agent_retention");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .unwrap();
    let root = Directory::new();
    report(&root.0, &url, true, 0, 0).await;
    let first = heartbeat(&pool).await;
    assert!(first.0.is_some());
    assert!(first.1.is_none());
    let user = Uuid::new_v4().to_string();
    let workspace = Uuid::new_v4().to_string();
    let thread = Uuid::new_v4();
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Retention fixture',$2,true)",
    )
    .bind(&user)
    .bind(format!("{user}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Retention fixture',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'Retention fixture')").bind(thread).bind(&workspace).bind(&user).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'completed','forge-native','{}')").bind(run).bind(thread).bind(&user).execute(&pool).await.unwrap();
    let aid = Uuid::new_v4();
    let future = Uuid::new_v4();
    let rid = Uuid::new_v4();
    let uid = Uuid::new_v4();
    let recent = Uuid::new_v4();
    let hash = "a".repeat(64);
    for (id, expired) in [(aid, true), (future, false)] {
        let reference = format!("attachments/{id}");
        bytes(&root.0, &reference).await;
        sqlx::query("INSERT INTO agent_attachments(id,workspace_id,user_id,name,content_type,size_bytes,storage_reference,checksum,expires_at) VALUES($1,$2,$3,'private-fixture.txt','text/plain',23,$4,$5,clock_timestamp()+CASE WHEN $6 THEN interval '-1 day' ELSE interval '1 day' END)").bind(id).bind(&workspace).bind(&user).bind(reference).bind(&hash).bind(expired).execute(&pool).await.unwrap();
    }
    let reference = format!("{run}/{rid}");
    tokio::fs::create_dir_all(root.0.join(&reference))
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum,retention_expires_at) VALUES($1,$2,'file','private-fixture.txt','text/plain',23,$3,$4,clock_timestamp()-interval '1 day')").bind(rid).bind(run).bind(&reference).bind(&hash).execute(&pool).await.unwrap();
    for (id, quarantined) in [(uid, false), (recent, true)] {
        let reference = format!("files/{id}");
        bytes(&root.0, &reference).await;
        sqlx::query("INSERT INTO file_upload_intents(id,workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,created_at,expires_at,token_expires_at) VALUES($1,$2,$3,$1,$4,'{\"kind\":\"agent-attachment\"}','private-fixture.txt','text/plain',23,$4,$5,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',CASE WHEN $6 THEN clock_timestamp()+interval '1 minute' ELSE NULL END)").bind(id).bind(&workspace).bind(&user).bind(&hash).bind(reference).bind(quarantined).execute(&pool).await.unwrap();
    }
    report(&root.0, &url, false, 2, 1).await;
    let failed = heartbeat(&pool).await;
    assert_eq!(failed.0, first.0);
    assert!(failed.1.is_some());
    assert!(!root.0.join(format!("attachments/{aid}")).exists());
    assert!(!root.0.join(format!("files/{uid}")).exists());
    assert!(root.0.join(format!("files/{recent}")).exists());
    assert!(root.0.join(format!("attachments/{future}")).exists());
    let kept: bool =
        sqlx::query_scalar("SELECT deleted_at IS NULL FROM agent_artifacts WHERE id=$1")
            .bind(rid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(kept);
    tokio::fs::remove_dir(root.0.join(&reference))
        .await
        .unwrap();
    bytes(&root.0, &reference).await;
    report(&root.0, &url, true, 1, 0).await;
    let recovered = heartbeat(&pool).await;
    assert!(recovered.0 > failed.0);
    assert_eq!(recovered.1, failed.1);
    report(&root.0, &url, true, 0, 0).await;
    // An early SQL failure in one sweep still waits for the independent sweeps.
    sqlx::query(
        "UPDATE agent_attachments SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
    )
    .bind(future)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("ALTER TABLE agent_artifacts RENAME TO retention_unavailable_artifacts")
        .execute(&pool)
        .await
        .unwrap();
    let before = heartbeat(&pool).await;
    let failed = command(&root.0, Some(&url), &["agent"]).await;
    sqlx::query("ALTER TABLE retention_unavailable_artifacts RENAME TO agent_artifacts")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!failed.status.success());
    assert!(failed.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&failed.stderr).unwrap(),
        json!({"code":"RETENTION_FAILED"})
    );
    assert!(!root.0.join(format!("attachments/{future}")).exists());
    let after = heartbeat(&pool).await;
    assert_eq!(after.0, before.0);
    assert!(after.1 > before.1);
    report(&root.0, &url, true, 0, 0).await;
    pool.close().await;
}
