//! HS256 agent credentials retain the source's audiences and scoped claims.
//! Explicit time/nonce inputs keep minting deterministic; live authorization is
//! still required by the database adapter when a token is exercised.
use crate::{
    actor::{Actor, ApiScope, Authentication},
    canonical::javascript_stringify,
    contract as c,
};
use base64::{
    Engine, alphabet,
    engine::{
        DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::URL_SAFE_NO_PAD,
    },
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Capability,
    LocalIngest,
    ModelAccess,
    Artifact,
    RuntimeChannel,
}
impl Kind {
    pub fn audience(self) -> &'static str {
        match self {
            Self::Capability => "forge-capability",
            Self::LocalIngest => "forge-local-ingest",
            Self::ModelAccess => "forge-model-access",
            Self::Artifact => "forge-agent-artifact",
            Self::RuntimeChannel => "forge-agent-runtime",
        }
    }
}
#[derive(Debug, thiserror::Error)]
#[error("The agent credential is invalid or outside its allowed scope.")]
pub struct TokenError;
type Result<T> = std::result::Result<T, TokenError>;
fn key(secret: &str) -> Result<Hmac<Sha256>> {
    if secret.encode_utf16().count() < 32 {
        return Err(TokenError);
    }
    Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| TokenError)
}
pub fn capability_scopes(capabilities: &[String]) -> Vec<&'static str> {
    let mut scopes = vec![];
    if capabilities
        .iter()
        .any(|v| v.starts_with("teams.") || v == "workspace.describe")
    {
        scopes.push("teams:read");
    }
    if capabilities.iter().any(|v| v == "teams.update") {
        scopes.push("teams:write");
    }
    if capabilities.iter().any(|v| v == "artifacts.create") {
        scopes.push("agents:write");
    }
    scopes
}
pub fn capability_claims(
    actor: &Actor,
    run: &str,
    token_id: &str,
    capabilities: &[String],
) -> Value {
    json!({"workspaceId":actor.workspace_id,"workspaceRole":actor.workspace_role,"runId":run,"tokenId":token_id,"scopes":capability_scopes(capabilities),"capabilities":capabilities,"sub":actor.user_id})
}
pub fn mint(
    secret: &str,
    kind: Kind,
    mut claims: Value,
    now: i64,
    expires_seconds: f64,
) -> Result<String> {
    if !claims.is_object() {
        return Err(TokenError);
    }
    let ttl = if kind == Kind::Artifact {
        if expires_seconds.is_nan() || expires_seconds.floor() == 0. {
            300.
        } else {
            expires_seconds.floor().clamp(1., 300.)
        }
    } else {
        if !expires_seconds.is_finite()
            || javascript_stringify(&json!(expires_seconds.max(30.))).contains('e')
        {
            return Err(TokenError);
        }
        expires_seconds.max(30.).round()
    };
    let exp = (now as f64) + ttl;
    if !exp.is_finite() {
        return Err(TokenError);
    }
    claims["iss"] = json!("forge");
    claims["aud"] = json!(kind.audience());
    if !matches!(kind, Kind::Artifact | Kind::RuntimeChannel) {
        claims["jti"] = claims["tokenId"].clone();
    }
    claims["iat"] = json!(now);
    claims["exp"] = json!(exp);
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(javascript_stringify(&claims));
    let input = format!("{header}.{payload}");
    let mut mac = key(secret)?;
    mac.update(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
fn decode(value: &str) -> Result<Vec<u8>> {
    // JOSE accepts either alphabet and insignificant ASCII base64 whitespace.
    let value = value
        .chars()
        .filter(|c| ![' ', '\t', '\n', '\r', '\u{c}'].contains(c))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect::<String>();
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(value)
    .map_err(|_| TokenError)
}
fn claims(kind: Kind, payload: Value) -> Result<Value> {
    let mut keys = vec!["sub", "workspaceId"];
    keys.extend(match kind {
        Kind::Capability => vec![
            "workspaceRole",
            "runId",
            "tokenId",
            "scopes",
            "capabilities",
        ],
        Kind::LocalIngest => vec!["runId", "threadId", "tokenId"],
        Kind::ModelAccess => vec!["runId", "connectionId", "provider", "modelId", "tokenId"],
        Kind::Artifact => vec!["artifactId"],
        Kind::RuntimeChannel => vec![
            "correlationId",
            "runId",
            "forgeCapabilityToken",
            "forgeModelAccessToken",
            "provider",
            "modelId",
            "reasoningEffort",
        ],
    });
    let mut o = c::Object::new(payload, &keys, false).map_err(|_| TokenError)?;
    for key in ["sub", "workspaceId"] {
        o.required(key, |v| c::text(v, 1, usize::MAX, false))
            .map_err(|_| TokenError)?;
    }
    match kind {
        Kind::Capability => {
            o.required("workspaceRole", |v| c::text(v, 1, usize::MAX, false))
                .map_err(|_| TokenError)?;
            for key in ["scopes", "capabilities"] {
                o.required(key, |v| c::list(v, 0, usize::MAX, c::string))
                    .map_err(|_| TokenError)?;
            }
        }
        Kind::ModelAccess | Kind::RuntimeChannel => {
            o.required("provider", |v| c::text(v, 1, 100, false))
                .map_err(|_| TokenError)?;
            o.required("modelId", |v| c::text(v, 1, 255, false))
                .map_err(|_| TokenError)?;
        }
        _ => {}
    }
    if kind == Kind::RuntimeChannel {
        o.optional("correlationId", c::uuid)
            .map_err(|_| TokenError)?;
        for key in ["forgeCapabilityToken", "forgeModelAccessToken"] {
            o.required(key, |v| c::text(v, 20, usize::MAX, false))
                .map_err(|_| TokenError)?;
        }
        o.required("reasoningEffort", |v| c::enumeration(v, super::EFFORTS))
            .map_err(|_| TokenError)?;
    }
    for key in keys
        .into_iter()
        .filter(|k| ["runId", "threadId", "tokenId", "connectionId", "artifactId"].contains(k))
    {
        o.required(key, c::uuid).map_err(|_| TokenError)?;
    }
    Ok(o.finish())
}
pub fn verify(secret: &str, kind: Kind, token: &str, now: i64) -> Result<Value> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(TokenError);
    }
    let header: Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| TokenError)?;
    if !header.is_object() || header["alg"] != "HS256" {
        return Err(TokenError);
    }
    if let Some(crit) = header.get("crit") {
        let crit = crit
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or(TokenError)?;
        for entry in crit {
            if entry != "b64" || !header["b64"].is_boolean() {
                return Err(TokenError);
            }
        }
        if header["b64"] == false {
            return Err(TokenError);
        }
    }
    let mut mac = key(secret)?;
    mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    mac.verify_slice(&decode(parts[2])?)
        .map_err(|_| TokenError)?;
    let payload: Value = serde_json::from_slice(&decode(parts[1])?).map_err(|_| TokenError)?;
    if !payload.is_object()
        || payload["iss"] != "forge"
        || !(payload["aud"] == kind.audience()
            || payload["aud"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == kind.audience())))
    {
        return Err(TokenError);
    }
    for name in ["iat", "nbf", "exp"] {
        if payload.get(name).is_some_and(|v| v.as_f64().is_none()) {
            return Err(TokenError);
        }
    }
    let now = now as f64;
    if payload["nbf"].as_f64().is_some_and(|n| n > now)
        || payload["exp"].as_f64().is_some_and(|n| n <= now)
    {
        return Err(TokenError);
    }
    if kind == Kind::Artifact {
        let issued = payload["iat"].as_f64().ok_or(TokenError)?;
        payload["exp"].as_f64().ok_or(TokenError)?;
        if !(0. ..=300.).contains(&(now - issued)) {
            return Err(TokenError);
        }
    }
    claims(kind, payload)
}
pub fn verify_capability(
    secret: &str,
    token: &str,
    run: &str,
    workspace: &str,
    capability: &str,
    now: i64,
) -> Result<Actor> {
    let c = verify(secret, Kind::Capability, token, now)?;
    if c["runId"] != run
        || c["workspaceId"] != workspace
        || !c["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == capability)
    {
        return Err(TokenError);
    }
    // Unknown source scope strings confer no permission. Known scopes retain
    // their order; application authorization operates on this typed subset.
    let scopes = c["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| serde_json::from_value::<ApiScope>(s.clone()).ok())
        .collect();
    Ok(Actor {
        user_id: c["sub"].as_str().unwrap().into(),
        workspace_id: c["workspaceId"].as_str().unwrap().into(),
        workspace_role: c["workspaceRole"].as_str().unwrap().into(),
        authentication: Authentication::Agent {
            run_id: c["runId"].as_str().unwrap().into(),
            token_id: c["tokenId"].as_str().unwrap().into(),
        },
        scopes: Some(scopes),
        loop_scope: None,
    })
}
pub fn verify_local(
    secret: &str,
    token: &str,
    a: &Actor,
    run: &str,
    thread: Option<&str>,
    now: i64,
) -> Result<Value> {
    let c = verify(secret, Kind::LocalIngest, token, now)?;
    if c["sub"] != a.user_id
        || c["workspaceId"] != a.workspace_id
        || c["runId"] != run
        || thread
            .filter(|s| !s.is_empty())
            .is_some_and(|s| c["threadId"] != s)
    {
        return Err(TokenError);
    }
    Ok(c)
}
pub fn verify_artifact(
    secret: &str,
    token: &str,
    a: &Actor,
    artifact: &str,
    now: i64,
) -> Result<()> {
    let c = verify(secret, Kind::Artifact, token, now)?;
    if c["sub"] != a.user_id || c["workspaceId"] != a.workspace_id || c["artifactId"] != artifact {
        return Err(TokenError);
    }
    Ok(())
}
