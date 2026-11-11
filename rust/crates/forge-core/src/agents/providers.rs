//! Provider catalog normalization and endpoint/managed-model policy.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    ConnectionNotFound,
    DiscoveryFailed,
    InvalidEndpoint,
    VaultUnavailable,
    PolicyBlocked,
}
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: Code,
    pub message: &'static str,
}
impl Error {
    pub fn new(code: Code, message: &'static str) -> Self {
        Self { code, message }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub model_id: String,
    pub display_name: String,
    pub input_modalities: Vec<String>,
    pub supports_tools: bool,
    pub supports_code: bool,
    pub supported_reasoning_efforts: Vec<String>,
    pub context_window_tokens: Option<i32>,
}
#[derive(Clone)]
pub struct DiscoveryInput {
    pub provider: String,
    pub api_key: String,
    pub endpoint_url: Option<String>,
    pub model_ids: Vec<String>,
}
#[async_trait]
pub trait Discovery: Send + Sync {
    async fn validate_endpoint(&self, value: &str) -> Result<String, Error>;
    async fn discover(&self, input: &DiscoveryInput) -> Result<Vec<Model>, Error>;
}
pub fn label(provider: &str) -> &str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "google" => "Google",
        "minimax" => "MiniMax",
        "mistral" => "Mistral",
        "xai" => "xAI",
        "deepseek" => "DeepSeek",
        "kimi" => "Kimi",
        "custom-openai" => "OpenAI compatible",
        "custom-anthropic" => "Anthropic compatible",
        _ => provider,
    }
}
pub fn built_in(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai" => "https://api.openai.com/v1/",
        "anthropic" => "https://api.anthropic.com/v1/",
        "google" => "https://generativelanguage.googleapis.com/v1beta/",
        "minimax" => "https://api.minimax.io/v1/",
        "mistral" => "https://api.mistral.ai/v1/",
        "xai" => "https://api.x.ai/v1/",
        "deepseek" => "https://api.deepseek.com/v1/",
        "kimi" => "https://api.moonshot.ai/v1/",
        _ => return None,
    })
}
pub fn headers(provider: &str, key: &str) -> Vec<(&'static str, String)> {
    match provider {
        "anthropic" | "custom-anthropic" => vec![
            ("anthropic-version", "2023-06-01".into()),
            ("x-api-key", key.into()),
        ],
        "google" => vec![("x-goog-api-key", key.into())],
        _ => vec![("authorization", format!("Bearer {key}"))],
    }
}
pub fn text_model(id: &str) -> bool {
    let s = id.to_ascii_lowercase();
    ![
        "embedding",
        "moderation",
        "tts",
        "speech",
        "audio",
        "image",
        "whisper",
        "transcri",
    ]
    .iter()
    .any(|p| s.contains(p))
}
fn tools(provider: &str, id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let starts = |prefixes: &[&str]| prefixes.iter().any(|p| id.starts_with(p));
    match provider {
        "custom-openai" | "custom-anthropic" => true,
        "openai" => {
            starts(&["gpt-", "codex"])
                || ["o1", "o3", "o4"]
                    .iter()
                    .any(|p| id == *p || id.starts_with(&format!("{p}-")))
        }
        "anthropic" => starts(&["claude-"]),
        "google" => starts(&["gemini-"]),
        "minimax" => starts(&["minimax-", "abab"]),
        "mistral" => starts(&["mistral-", "ministral-", "codestral-", "pixtral-"]),
        "xai" => starts(&["grok-"]),
        "deepseek" => starts(&["deepseek-chat", "deepseek-reasoner"]),
        "kimi" => starts(&["kimi-", "moonshot-"]),
        _ => false,
    }
}
pub fn normalize(provider: &str, payload: Option<&Value>, manual: &[String]) -> Vec<Model> {
    let mut ids = Vec::new();
    if let Some(rows) =
        payload.and_then(|v| v["data"].as_array().or_else(|| v["models"].as_array()))
    {
        for row in rows {
            if let Some(id) = row["id"].as_str().or_else(|| {
                row["name"]
                    .as_str()
                    .map(|s| s.strip_prefix("models/").unwrap_or(s))
            }) {
                let id = crate::text::trim(id);
                if !id.is_empty() && text_model(id) {
                    ids.push(id.to_owned());
                }
            }
        }
    }
    ids.extend(manual.iter().filter(|s| text_model(s)).cloned());
    let mut seen = HashSet::new();
    ids.retain(|s| seen.insert(s.clone()));
    let collator = icu_collator::Collator::try_new(Default::default(), Default::default()).unwrap();
    ids.sort_by(|a, b| collator.compare(a, b));
    ids.truncate(250);
    ids.into_iter()
        .map(|id| {
            let lower = id.to_ascii_lowercase();
            let reasoning = matches!(provider, "openai" | "custom-openai")
                && ["o1", "o3", "o4", "gpt-5", "codex"]
                    .iter()
                    .any(|p| lower.starts_with(p));
            let tools = tools(provider, &id);
            Model {
                display_name: id.clone(),
                model_id: id,
                input_modalities: vec!["text".into()],
                supports_tools: tools,
                supports_code: tools,
                supported_reasoning_efforts: if reasoning {
                    vec!["none", "low", "medium", "high", "xhigh"]
                } else {
                    vec!["none"]
                }
                .into_iter()
                .map(str::to_owned)
                .collect(),
                context_window_tokens: None,
            }
        })
        .collect()
}
pub fn endpoint(value: &str) -> Result<Url, Error> {
    let invalid = || {
        Error::new(
            Code::InvalidEndpoint,
            "Custom server providers require an HTTPS URL without credentials or a custom port.",
        )
    };
    let mut url = Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.host_str().is_none()
    {
        return Err(invalid());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}
pub fn private_address(value: &str) -> bool {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let [a, b, c, _] = ip.octets();
            a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113)
                || a >= 224
        }
        Ok(IpAddr::V6(ip)) => {
            let s = ip.segments();
            ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_unique_local()
                || (s[0] & 0xff80) == 0xfe80
                || ip.is_multicast()
                || (s[0] == 0x2001 && s[1] == 0xdb8)
                || ip.to_ipv4_mapped().is_some()
        }
        Err(_) => true,
    }
}
pub fn managed_id(workspace: &str) -> String {
    let mut hash = Sha256::digest(format!("forge-managed-openai:{workspace}")).to_vec();
    hash.truncate(16);
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    uuid::Uuid::from_slice(&hash).unwrap().to_string()
}
fn managed_ids(env: &HashMap<String, String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids: Vec<_> = env
        .get("FORGE_MANAGED_OPENAI_MODELS")
        .into_iter()
        .flat_map(|s| s.split(','))
        .map(crate::text::trim)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 255
                && s.as_bytes()[0].is_ascii_alphanumeric()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        })
        .filter(|s| seen.insert(s.to_string()))
        .map(str::to_owned)
        .take(50)
        .collect();
    if ids.is_empty() {
        ids = [
            "gpt-6-astra",
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
        ]
        .map(str::to_owned)
        .to_vec();
    }
    ids
}
pub fn managed_models(connection: &str, env: &HashMap<String, String>) -> Vec<Value> {
    if env
        .get("OPENAI_API_KEY")
        .is_none_or(|s| crate::text::trim(s).is_empty())
    {
        return Vec::new();
    }
    managed_ids(env).into_iter().map(|id|json!({"selectionId":format!("{connection}:{id}"),"connectionId":connection,"executionKind":"forge-native","provider":"openai","modelId":id,"displayName":id,"providerLabel":"OpenAI","sourceLabel":"Forge managed","locality":"server-capable","billingMode":"forge-managed","inputModalities":["text"],"supportsTools":true,"supportsCode":true,"supportedReasoningEfforts":["low","medium","high","xhigh","max"],"contextWindowTokens":null,"status":"available"})).collect()
}
pub fn managed_key<'a>(
    connection: &str,
    workspace: &str,
    provider: &str,
    model: &str,
    env: &'a HashMap<String, String>,
) -> Option<&'a str> {
    if connection != managed_id(workspace)
        || provider != "openai"
        || !managed_ids(env).iter().any(|s| s == model)
    {
        return None;
    }
    env.get("OPENAI_API_KEY")
        .map(|s| crate::text::trim(s))
        .filter(|s| !s.is_empty())
}
