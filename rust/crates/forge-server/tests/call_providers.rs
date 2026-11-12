use async_trait::async_trait;
use forge_core::calls::providers::{Error, Exchange, Gateway, TokenRequest};
use forge_server::call_providers::{Client, HttpTransport, Transport};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
#[tokio::test]
async fn meeting_provider_disablement_and_isolation_reject_before_transport_and_errors_are_redacted()
 {
    #[derive(Default)]
    struct Probe(AtomicUsize);
    #[async_trait]
    impl Transport for Probe {
        async fn exchange(&self, _: TokenRequest) -> Result<Value, Error> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"access_token":"private-access","expires_in":60}))
        }
    }
    let base = HashMap::from([
        (
            "BETTER_AUTH_URL".into(),
            "https://forge.example.test".into(),
        ),
        ("FORGE_ZOOM_CLIENT_ID".into(), "fixture-id".into()),
        (
            "FORGE_ZOOM_CLIENT_SECRET".into(),
            "private-client-secret".into(),
        ),
    ]);
    let probe = Arc::new(Probe::default());
    for (key, value) in [
        ("FORGE_CALLS_ENABLED", "false"),
        ("FORGE_CALLS_PROVIDERS", "google"),
        ("FORGE_ENVIRONMENT", "staging"),
        ("FORGE_RESOURCE_PROFILE", "preview"),
    ] {
        let mut env = base.clone();
        env.insert(key.into(), value.into());
        let client = Client::new(env, probe.clone());
        assert!(
            client
                .authorization_url("zoom", "private-state", "challenge")
                .is_err()
        );
        let error = client
            .exchange(
                "zoom",
                Exchange::Refresh {
                    refresh_token: "private-refresh",
                },
            )
            .await
            .err()
            .unwrap();
        assert!(!error.to_string().contains("private"));
    }
    assert_eq!(probe.0.load(Ordering::SeqCst), 0);
    let mut client = Client::new(base, probe.clone());
    client.now = Arc::new(|| 1893456000000);
    let result = client
        .exchange(
            "zoom",
            Exchange::Refresh {
                refresh_token: "private-refresh",
            },
        )
        .await
        .unwrap();
    assert_eq!(result.refresh_token.as_deref(), Some("private-refresh"));
    assert_eq!(result.expires_at, 1893456060000.);
    assert_eq!(probe.0.load(Ordering::SeqCst), 1);
    let http = HttpTransport::new().unwrap();
    for url in [
        "http://127.0.0.1:9/private",
        "https://zoom.us.attacker.invalid/oauth/token",
        "https://zoom.us/oauth/token?redirect=private",
    ] {
        assert!(
            http.exchange(TokenRequest {
                url: url.into(),
                form: vec![("client_secret".into(), "private-secret".into())],
                headers: vec![]
            })
            .await
            .is_err()
        );
    }
}
