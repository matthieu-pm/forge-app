use async_trait::async_trait;
use forge_server::oauth_provider::{
    ChatGptClient, OidcTransport, ProviderError, verify_identity_with_jwks,
};
use serde_json::{Value, json};
use std::sync::Arc;
use url::Url;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap()
}

#[test]
fn oidc_identity_verification_matches_forge_reference_cases() {
    let fixture = fixtures();
    let oidc = &fixture["oidc"];
    let keys = serde_json::from_value(oidc["jwks"].clone()).unwrap();
    for case in oidc["cases"].as_array().unwrap() {
        let result = verify_identity_with_jwks(
            case["token"].as_str().unwrap(),
            oidc["clientId"].as_str().unwrap(),
            oidc["nonce"].as_str().unwrap(),
            &keys,
        );
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(identity) = result {
            assert_eq!(serde_json::to_value(identity).unwrap(), case["identity"]);
        }
    }
}

struct DiscoveryTransport {
    untrusted: bool,
}

#[async_trait]
impl OidcTransport for DiscoveryTransport {
    async fn get_json(&self, url: &Url) -> Result<Value, ProviderError> {
        assert_eq!(
            url.as_str(),
            "https://auth.openai.com/.well-known/openid-configuration"
        );
        Ok(
            json!({"issuer":"https://auth.openai.com","authorization_endpoint":if self.untrusted {"https://untrusted.example/authorize"}else{"https://auth.openai.com/authorize"},"token_endpoint":"https://auth.openai.com/token","jwks_uri":"https://auth.openai.com/jwks"}),
        )
    }
    async fn exchange(
        &self,
        _: &Url,
        _: &[(String, String)],
        _: Option<(&str, &str)>,
    ) -> Result<Value, ProviderError> {
        panic!("Authorization URL construction must not exchange tokens")
    }
}

#[tokio::test]
async fn authorization_uses_the_existing_pkce_nonce_and_browser_scope() {
    let fixture = fixtures();
    let oidc = &fixture["oidc"];
    let client = ChatGptClient::new(
        "oaiapp_forge".into(),
        None,
        Arc::new(DiscoveryTransport { untrusted: false }),
    )
    .unwrap();
    let url = client
        .authorization_url(
            "browser-state",
            oidc["verifier"].as_str().unwrap(),
            "https://forge.example/api/auth/callback/chatgpt",
        )
        .await
        .unwrap();
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(query["code_challenge"], oidc["challenge"].as_str().unwrap());
    assert_eq!(query["nonce"], oidc["nonce"].as_str().unwrap());
    assert_eq!(query["scope"], "openid profile email");
    assert_eq!(query["state"], "browser-state");
}

#[tokio::test]
async fn discovery_cannot_redirect_credentials_to_another_origin() {
    let client = ChatGptClient::new(
        "oaiapp_forge".into(),
        None,
        Arc::new(DiscoveryTransport { untrusted: true }),
    )
    .unwrap();
    assert!(
        client
            .authorization_url("state", &"a".repeat(43), "https://forge.example/callback")
            .await
            .is_err()
    );
}
