//! The existing ChatGPT OIDC integration. Discovery is constrained to the
//! issuer; identity is accepted only after signature, issuer, audience, expiry,
//! subject and browser-transaction nonce validation. Provider tokens are transient.

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_identity::{pkce_challenge, website_nonce};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::{OnceCell, RwLock};
use url::Url;

pub const CHATGPT_ISSUER: &str = "https://auth.openai.com";

#[derive(Debug)]
pub struct ProviderError;

pub use forge_identity::SocialIdentity as Identity;

#[async_trait]
pub trait OidcTransport: Send + Sync {
    async fn get_json(&self, url: &Url) -> Result<Value, ProviderError>;
    async fn exchange(
        &self,
        url: &Url,
        form: &[(String, String)],
        basic_auth: Option<(&str, &str)>,
    ) -> Result<Value, ProviderError>;
}

pub struct HttpTransport(reqwest::Client);

impl HttpTransport {
    pub fn new() -> Result<Self, ProviderError> {
        Ok(Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| ProviderError)?,
        ))
    }
}

#[async_trait]
impl OidcTransport for HttpTransport {
    async fn get_json(&self, url: &Url) -> Result<Value, ProviderError> {
        let response = self
            .0
            .get(url.clone())
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| ProviderError)?;
        if !response.status().is_success() {
            return Err(ProviderError);
        }
        response.json().await.map_err(|_| ProviderError)
    }
    async fn exchange(
        &self,
        url: &Url,
        form: &[(String, String)],
        basic_auth: Option<(&str, &str)>,
    ) -> Result<Value, ProviderError> {
        let mut request = self
            .0
            .post(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .form(form);
        if let Some((id, secret)) = basic_auth {
            let encode = |value: &str| {
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("value", value)
                    .finish()[6..]
                    .to_owned()
            };
            request = request.header(
                reqwest::header::AUTHORIZATION,
                format!(
                    "Basic {}",
                    STANDARD.encode(format!("{}:{}", encode(id), encode(secret)))
                ),
            );
        }
        let response = request.send().await.map_err(|_| ProviderError)?;
        if !response.status().is_success() {
            return Err(ProviderError);
        }
        response.json().await.map_err(|_| ProviderError)
    }
}

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: Url,
    token_endpoint: Url,
    jwks_uri: Url,
    revocation_endpoint: Option<Url>,
}

pub struct ChatGptClient {
    client_id: String,
    client_secret: Option<String>,
    transport: Arc<dyn OidcTransport>,
    discovery: OnceCell<Discovery>,
    keys: RwLock<Option<JwkSet>>,
}

impl ChatGptClient {
    pub fn new(
        client_id: String,
        client_secret: Option<String>,
        transport: Arc<dyn OidcTransport>,
    ) -> Result<Self, ProviderError> {
        if !client_id.starts_with("oaiapp_") || client_secret.as_ref().is_some_and(String::is_empty)
        {
            return Err(ProviderError);
        }
        Ok(Self {
            client_id,
            client_secret,
            transport,
            discovery: OnceCell::new(),
            keys: RwLock::new(None),
        })
    }
    pub fn from_environment() -> Result<Option<Self>, ProviderError> {
        let Some(id) = std::env::var("OPENAI_CLIENT_ID")
            .ok()
            .filter(|id| id.starts_with("oaiapp_"))
        else {
            return Ok(None);
        };
        let secret = match std::env::var("OPENAI_CLIENT_AUTH_METHOD")
            .as_deref()
            .unwrap_or("none")
        {
            "none" => None,
            "client_secret_basic" => match std::env::var("OPENAI_CLIENT_SECRET")
                .ok()
                .filter(|secret| !secret.is_empty())
            {
                Some(secret) => Some(secret),
                None => return Ok(None),
            },
            _ => return Ok(None),
        };
        Self::new(id, secret, Arc::new(HttpTransport::new()?)).map(Some)
    }
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    async fn discovery(&self) -> Result<&Discovery, ProviderError> {
        self.discovery
            .get_or_try_init(|| async {
                let raw = self
                    .transport
                    .get_json(
                        &Url::parse(&format!(
                            "{CHATGPT_ISSUER}/.well-known/openid-configuration"
                        ))
                        .map_err(|_| ProviderError)?,
                    )
                    .await?;
                let discovery: Discovery =
                    serde_json::from_value(raw).map_err(|_| ProviderError)?;
                if discovery.issuer != CHATGPT_ISSUER {
                    return Err(ProviderError);
                }
                for endpoint in [
                    &discovery.authorization_endpoint,
                    &discovery.token_endpoint,
                    &discovery.jwks_uri,
                ]
                .into_iter()
                .chain(discovery.revocation_endpoint.iter())
                {
                    if endpoint.origin().ascii_serialization() != CHATGPT_ISSUER
                        || !endpoint.username().is_empty()
                        || endpoint.password().is_some()
                    {
                        return Err(ProviderError);
                    }
                }
                Ok(discovery)
            })
            .await
    }

    pub async fn authorization_url(
        &self,
        state: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Url, ProviderError> {
        let discovery = self.discovery().await?;
        let mut url = discovery.authorization_endpoint.clone();
        url.set_query(None);
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", "openid profile email")
            .append_pair("state", state)
            .append_pair("nonce", &website_nonce(verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &pkce_challenge(verifier));
        Ok(url)
    }

    pub async fn finish(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Identity, ProviderError> {
        if code.is_empty() || !(43..=128).contains(&verifier.len()) {
            return Err(ProviderError);
        }
        let discovery = self.discovery().await?;
        let form = vec![
            ("grant_type".into(), "authorization_code".into()),
            ("client_id".into(), self.client_id.clone()),
            ("code".into(), code.into()),
            ("code_verifier".into(), verifier.into()),
            ("redirect_uri".into(), redirect_uri.into()),
        ];
        let tokens = self
            .transport
            .exchange(
                &discovery.token_endpoint,
                &form,
                self.client_secret
                    .as_deref()
                    .map(|secret| (self.client_id.as_str(), secret)),
            )
            .await?;
        let token = tokens
            .get("id_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .ok_or(ProviderError)?;
        // Cached keys may rotate. Refresh once if the current key set cannot verify.
        if let Some(keys) = self.keys.read().await.as_ref()
            && let Ok(identity) =
                verify_identity_with_jwks(token, &self.client_id, &website_nonce(verifier), keys)
        {
            return Ok(identity);
        }
        let keys: JwkSet =
            serde_json::from_value(self.transport.get_json(&discovery.jwks_uri).await?)
                .map_err(|_| ProviderError)?;
        let identity =
            verify_identity_with_jwks(token, &self.client_id, &website_nonce(verifier), &keys)?;
        *self.keys.write().await = Some(keys);
        Ok(identity)
    }
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    nonce: String,
    iat: i64,
    #[serde(default)]
    email: Value,
    #[serde(default)]
    name: Value,
    #[serde(default)]
    picture: Value,
    #[serde(default)]
    email_verified: Value,
}

pub fn verify_identity_with_jwks(
    token: &str,
    client_id: &str,
    nonce: &str,
    keys: &JwkSet,
) -> Result<Identity, ProviderError> {
    let encoded = token.split('.').next().ok_or(ProviderError)?;
    let raw: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| ProviderError)?,
    )
    .map_err(|_| ProviderError)?;
    if raw.get("crit").is_some()
        || raw
            .get("b64")
            .is_some_and(|value| value != &Value::Bool(true))
    {
        return Err(ProviderError);
    }
    let header = decode_header(token).map_err(|_| ProviderError)?;
    if !matches!(
        header.alg,
        Algorithm::RS256
            | Algorithm::RS384
            | Algorithm::RS512
            | Algorithm::PS256
            | Algorithm::PS384
            | Algorithm::PS512
            | Algorithm::ES256
            | Algorithm::ES384
            | Algorithm::EdDSA
    ) {
        return Err(ProviderError);
    }
    let mut validation = Validation::new(header.alg);
    validation.leeway = 5;
    validation.validate_nbf = true;
    validation.set_issuer(&[CHATGPT_ISSUER]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "nonce"]);
    for key in &keys.keys {
        let metadata = serde_json::to_value(key).map_err(|_| ProviderError)?;
        if metadata
            .get("alg")
            .and_then(Value::as_str)
            .is_some_and(|algorithm| algorithm != format!("{:?}", header.alg))
            || metadata
                .get("use")
                .and_then(Value::as_str)
                .is_some_and(|purpose| purpose != "sig")
            || metadata
                .get("key_ops")
                .and_then(Value::as_array)
                .is_some_and(|operations| {
                    !operations
                        .iter()
                        .any(|operation| operation.as_str() == Some("verify"))
                })
        {
            continue;
        }
        if header
            .kid
            .as_ref()
            .is_some_and(|kid| key.common.key_id.as_ref() != Some(kid))
        {
            continue;
        }
        let Ok(key) = DecodingKey::from_jwk(key) else {
            continue;
        };
        let Ok(decoded) = decode::<Claims>(token, &key, &validation) else {
            continue;
        };
        let claims = decoded.claims;
        if claims.sub.is_empty() || !bool::from(claims.nonce.as_bytes().ct_eq(nonce.as_bytes())) {
            return Err(ProviderError);
        }
        let _issued_at = claims.iat;
        return Ok(Identity {
            subject: claims.sub,
            email: claims.email.as_str().map(str::to_owned),
            name: claims.name.as_str().map(str::to_owned),
            image: claims.picture.as_str().map(str::to_owned),
            email_verified: claims.email_verified == Value::Bool(true),
        });
    }
    Err(ProviderError)
}
