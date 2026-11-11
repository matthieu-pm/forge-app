use forge_agent_runtime::configuration::ConfiguredFactory;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};

#[test]
fn configuration_is_explicit_and_rejects_credential_destinations_and_unimplemented_backends() {
    let mut env = HashMap::from([
        ("FORGE_APP_ORIGIN".into(), "http://127.0.0.1:9".into()),
        ("FORGE_FEATURE_AGENT_CODE_MODE".into(), "false".into()),
    ]);
    assert!(ConfiguredFactory::new(&env).is_ok());
    env.insert("FORGE_FEATURE_AGENT_CODE_MODE".into(), "true".into());
    assert!(ConfiguredFactory::new(&env).is_err());
    env.insert("FORGE_RUST_RUNTIME_SANDBOX".into(), "docker".into());
    assert!(ConfiguredFactory::new(&env).is_err());
    env.insert("FORGE_RUST_RUNTIME_SANDBOX".into(), "vercel".into());
    env.insert("VERCEL_TEAM_ID".into(), "team_fixture".into());
    env.insert("VERCEL_PROJECT_ID".into(), "prj_fixture".into());
    assert!(ConfiguredFactory::new(&env).is_err());
    env.insert(
        "VERCEL_OIDC_TOKEN".into(),
        "public-fixture-platform-token".into(),
    );
    // Construction is entirely local; no sandbox or provider request is made.
    assert!(ConfiguredFactory::new(&env).is_ok());
    env.insert(
        "FORGE_RUST_RUNTIME_PEER_ORIGIN".into(),
        "https://different.invalid".into(),
    );
    assert!(ConfiguredFactory::new(&env).is_err());
    env.remove("FORGE_RUST_RUNTIME_PEER_ORIGIN");
    for origin in [
        "http://user:fixture-secret@127.0.0.1:9",
        "http://127.0.0.1:9/path",
        "http://127.0.0.1:9/?token=fixture-secret",
        "file:///private/file",
    ] {
        env.insert("FORGE_APP_ORIGIN".into(), origin.into());
        let error = ConfiguredFactory::new(&env)
            .err()
            .expect("reject invalid origin");
        assert!(!error.to_string().contains("fixture-secret"));
    }
}
#[tokio::test]
async fn native_cli_installs_only_when_requested_and_serves_local_health_without_provider_io() {
    let executable = env!("CARGO_BIN_EXE_forge-agent-runtime");
    let help = Command::new(executable)
        .env_clear()
        .arg("--help")
        .output()
        .await
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("migrate"));
    let missing = Command::new(executable).env_clear().output().await.unwrap();
    assert!(!missing.status.success());
    assert_eq!(
        String::from_utf8_lossy(&missing.stderr).trim(),
        "FORGE_RUST_RUNTIME_DATABASE_URL is required."
    );
    let url = std::env::var("FORGE_RUST_RUNTIME_TEST_DATABASE_URL")
        .expect("Use the disposable PostgreSQL milestone runner");
    let parsed = url::Url::parse(&url).unwrap();
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert_eq!(parsed.path(), "/forge_rust_runtime");
    for _ in 0..2 {
        let migration = timeout(
            Duration::from_secs(10),
            Command::new(executable)
                .env_clear()
                .env("FORGE_RUST_RUNTIME_DATABASE_URL", &url)
                .arg("migrate")
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            migration.status.success(),
            "{}",
            String::from_utf8_lossy(&migration.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&migration.stdout).trim(),
            "Private native runtime schema verified."
        );
    }
    let mut child = Command::new(executable)
        .env_clear()
        .env("FORGE_RUST_RUNTIME_DATABASE_URL", url)
        .env("FORGE_RUST_RUNTIME_BIND", "127.0.0.1:0")
        .env(
            "FORGE_AGENT_CHANNEL_SECRET",
            "public-native-cli-fixture-signing-secret",
        )
        .env("FORGE_APP_ORIGIN", "http://127.0.0.1:9")
        .env("FORGE_FEATURE_AGENT_CODE_MODE", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = timeout(Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let address: std::net::SocketAddr = line
        .strip_prefix("Native runtime listening on ")
        .unwrap()
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .get(format!("http://{address}/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["service"],
        "forge-native-runtime"
    );
    let response = client
        .get(format!("http://{address}/ready"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}
