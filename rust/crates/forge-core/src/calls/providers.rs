//! Provider OAuth contracts. Neither token values nor request bodies implement
//! Debug; adapters return only fixed public errors across the HTTP boundary.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use url::Url;
#[derive(Debug, thiserror::Error)]
#[error("The meeting provider operation failed.")]
pub struct Error;
#[derive(Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    pub expires_at: f64,
}
pub enum Exchange<'a> {
    Code { code: &'a str, verifier: &'a str },
    Refresh { refresh_token: &'a str },
}
#[async_trait]
pub trait Gateway: Send + Sync {
    fn authorization_url(
        &self,
        provider: &str,
        state: &str,
        challenge: &str,
    ) -> Result<String, Error>;
    async fn exchange(&self, provider: &str, input: Exchange<'_>) -> Result<Tokens, Error>;
    async fn native_calls(
        &self,
        _provider: &str,
        _token: &str,
        _since: chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<NativeCall>, Error> {
        Err(Error)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCall {
    pub external_id: String,
    pub title: String,
    #[serde(serialize_with = "serialize_time")]
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub duration: i32,
    pub participants: Vec<String>,
    pub transcript: Vec<super::TranscriptEntry>,
}
fn serialize_time<S: serde::Serializer>(
    time: &chrono::DateTime<chrono::Utc>,
    s: S,
) -> Result<S::Ok, S::Error> {
    s.serialize_str(&time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
#[async_trait]
pub trait Summarizer: Send + Sync {
    async fn summarize(&self, text: &str) -> Result<Value, Error>;
}
pub fn summary_request(env: &HashMap<String, String>, text: &str) -> Result<Value, Error> {
    if text.encode_utf16().count() > 250000 {
        return Err(Error);
    }
    let mut value: Value =
        serde_json::from_str(include_str!("../../data/call-summary-policy.json"))
            .expect("source summary request");
    if let Some(model) = env
        .get("FORGE_CALLS_SUMMARY_MODEL")
        .filter(|s| !s.is_empty())
    {
        value["model"] = serde_json::json!(model);
    }
    value["messages"][1]["content"] = serde_json::json!(text);
    Ok(value)
}
pub fn summary_response(value: Value) -> Result<Value, Error> {
    let text = value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");
    super::input("recap", crate::json::parse(text).map_err(|_| Error)?).map_err(|_| Error)
}
pub struct Config {
    pub provider: String,
    pub authorize: &'static str,
    pub token: &'static str,
    pub scope: &'static str,
    pub client_id: String,
    pub client_secret: String,
    pub redirect: String,
}
pub struct TokenRequest {
    pub url: String,
    pub form: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
}
impl Config {
    pub fn new(env: &HashMap<String, String>, provider: &str) -> Result<Self, Error> {
        crate::deployment::validate(env, "web").map_err(|_| Error)?;
        if !super::selected_providers(env).iter().any(|p| p == provider) {
            return Err(Error);
        }
        let index = super::PROVIDERS
            .iter()
            .position(|p| *p == provider)
            .ok_or(Error)?;
        let get = |key: &str| env.get(key).filter(|s| !s.is_empty()).cloned().ok_or(Error);
        let client_id = get(&format!("FORGE_{}_CLIENT_ID", super::PREFIXES[index]))?;
        let client_secret = get(&format!("FORGE_{}_CLIENT_SECRET", super::PREFIXES[index]))?;
        let redirect = Url::parse(&get("BETTER_AUTH_URL")?)
            .map_err(|_| Error)?
            .join("/api/calls/oauth/callback")
            .map_err(|_| Error)?
            .to_string();
        let (authorize, token, scope) = match provider {
            "google" => (
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                "https://www.googleapis.com/auth/meetings.space.readonly",
            ),
            "teams" => (
                "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
                "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
                "offline_access User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All",
            ),
            "zoom" => (
                "https://zoom.us/oauth/authorize",
                "https://zoom.us/oauth/token",
                "",
            ),
            _ => return Err(Error),
        };
        Ok(Self {
            provider: provider.into(),
            authorize,
            token,
            scope,
            client_id,
            client_secret,
            redirect,
        })
    }
    pub fn authorization_url(&self, state: &str, challenge: &str) -> String {
        let mut url = Url::parse(self.authorize).expect("fixed OAuth URL");
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("response_type", "code")
            .append_pair("state", state);
        if !self.scope.is_empty() {
            q.append_pair("scope", self.scope);
        }
        if self.provider != "zoom" {
            q.append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256");
        }
        if self.provider == "google" {
            q.append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
        drop(q);
        url.into()
    }
    pub fn request(&self, input: &Exchange<'_>) -> TokenRequest {
        let mut form = match input {
            Exchange::Code { code, verifier } => {
                let mut f = vec![
                    ("grant_type".into(), "authorization_code".into()),
                    ("code".into(), (*code).into()),
                    ("redirect_uri".into(), self.redirect.clone()),
                ];
                if self.provider != "zoom" {
                    f.push(("code_verifier".into(), (*verifier).into()));
                }
                f
            }
            Exchange::Refresh { refresh_token } => vec![
                ("grant_type".into(), "refresh_token".into()),
                ("refresh_token".into(), (*refresh_token).into()),
            ],
        };
        let mut headers = vec![(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        )];
        if self.provider == "zoom" {
            headers.push((
                "authorization".into(),
                format!(
                    "Basic {}",
                    STANDARD.encode(format!("{}:{}", self.client_id, self.client_secret))
                ),
            ));
        } else {
            form.push(("client_id".into(), self.client_id.clone()));
            form.push(("client_secret".into(), self.client_secret.clone()));
        }
        TokenRequest {
            url: self.token.into(),
            form,
            headers,
        }
    }
}
pub fn tokens(data: Value, input: &Exchange<'_>, now: i64) -> Result<Tokens, Error> {
    let access_token = data["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(Error)?
        .into();
    let refresh_token = match data.get("refresh_token").filter(|v| !v.is_null()) {
        Some(v) => Some(v.as_str().ok_or(Error)?.into()),
        None => match input {
            Exchange::Refresh { refresh_token } => Some((*refresh_token).into()),
            _ => None,
        },
    };
    let seconds = match data.get("expires_in").filter(|v| !v.is_null()) {
        Some(v) => v.as_f64().ok_or(Error)?,
        None => 3600.,
    };
    let expires_at = now as f64 + seconds * 1000.;
    if !expires_at.is_finite() {
        return Err(Error);
    }
    Ok(Tokens {
        access_token,
        refresh_token,
        expires_at,
    })
}
