use forge_store::{
    Database,
    jobs::{Enqueue, JobStore},
};
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::process::Command;
use uuid::Uuid;

#[tokio::test]
async fn job_operator_binary_requires_explicit_target_and_never_prints_private_payloads() {
    fn command() -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_forge-jobs"));
        cmd.env_clear();
        cmd
    }
    for env in [
        vec![],
        vec![("FORGE_ENVIRONMENT", "development")],
        vec![
            ("DATABASE_URL", "postgres://private-password@localhost"),
            ("FORGE_ENVIRONMENT", "development"),
        ],
        vec![
            ("DATABASE_URL", "postgres://localhost/db"),
            ("FORGE_ENVIRONMENT", "development"),
            ("NODE_ENV", "production"),
        ],
    ] {
        let output = command().envs(env).arg("list").output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":"INVALID_INPUT"})
        );
    }
    let connection = std::env::var("FORGE_RUST_TEST_DATABASE_URL").unwrap();
    let options: PgConnectOptions = connection.parse().unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert_eq!(options.get_username(), "forge_rust_test");
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await
        .unwrap();
    let store = JobStore::new(Database::new(pool.clone()));
    let id = store
        .enqueue(&Enqueue {
            kind: "cli-fixture".into(),
            scope: "fixture".into(),
            identity: Uuid::new_v4().to_string(),
            input: json!({"secret":"private-cli-input"}),
            scheduled_at: "2020-01-01T00:00:00Z".parse().unwrap(),
            max_attempts: 5,
        })
        .await
        .unwrap();
    let output = command()
        .env("DATABASE_URL", &connection)
        .env("FORGE_ENVIRONMENT", "development")
        .args(["inspect", &id.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["jobs"][0]["id"], id.to_string());
    assert_eq!(result["jobs"][0]["state"], "queued");
    assert!(!result.to_string().contains("private-cli-input"));
    assert!(result["jobs"][0].get("input").is_none());
    let output = command()
        .env("DATABASE_URL", connection)
        .env("FORGE_ENVIRONMENT", "development")
        .args(["inspect", "not-an-id"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap(),
        json!({"code":"INVALID_INPUT"})
    );
    pool.close().await;
}
