use serde_json::{Value, json};
use std::process::Command;
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_forge-invitations"));
    command.env_clear();
    command
}
#[test]
fn invitation_worker_requires_explicit_configuration_and_rejects_unknown_commands() {
    for args in [
        vec![],
        vec!["unknown"],
        vec!["run", "invalid"],
        vec!["run", "extra", "args"],
    ] {
        let output = command().args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":"INVALID_COMMAND"})
        );
    }
    let output = command().arg("run").output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap(),
        json!({"code":"INVALID_CONFIGURATION"})
    );
    for (url, key) in [
        ("https://forge.example.test", ""),
        ("https://user:private@forge.example.test", "fixture-key"),
    ] {
        let output = command()
            .arg("run")
            .env(
                "DATABASE_URL",
                "postgres://private-password@127.0.0.1:1/missing",
            )
            .env("FORGE_ENVIRONMENT", "development")
            .env("RESEND_API_KEY", key)
            .env("BETTER_AUTH_URL", url)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":"INVALID_CONFIGURATION"})
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-password"));
    }
}
#[tokio::test]
async fn configured_invitation_worker_runs_against_only_the_selected_empty_job() {
    let url = std::env::var("FORGE_RUST_TEST_DATABASE_URL").unwrap();
    let options: sqlx::postgres::PgConnectOptions = url.parse().unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert_eq!(options.get_username(), "forge_rust_test");
    let id = uuid::Uuid::new_v4();
    let output = command()
        .args(["run", &id.to_string()])
        .env("DATABASE_URL", url)
        .env("FORGE_ENVIRONMENT", "development")
        .env("RESEND_API_KEY", "fixture-not-a-credential")
        .env("BETTER_AUTH_URL", "https://forge.example.test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"state":"idle"})
    );
}
