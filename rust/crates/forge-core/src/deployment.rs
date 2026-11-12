//! Reviewed staging/preview resource isolation from the owning environment
//! package. Errors contain no environment values or credentials.
use crate::contract::ContractError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::LazyLock};
use url::Url;
type Env = HashMap<String, String>;
static POLICY: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/deployment-policy.json"))
        .expect("reviewed resource policy")
});
fn value<'a>(env: &'a Env, key: &str) -> &'a str {
    env.get(key).map(String::as_str).unwrap_or("")
}
fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().expect("policy field")
}
fn credential(key: &str) -> bool {
    [
        "OPENAI",
        "ANTHROPIC",
        "GOOGLE",
        "MINIMAX",
        "MISTRAL",
        "XAI",
        "DEEPSEEK",
        "KIMI",
    ]
    .iter()
    .any(|p| key == format!("{p}_API_KEY"))
        || [
            "RESEND_API_KEY",
            "POLAR_ACCESS_TOKEN",
            "POLAR_WEBHOOK_SECRET",
            "AI_GATEWAY_API_KEY",
        ]
        .contains(&key)
        || crate::calls::PREFIXES.iter().any(|p| {
            ["CLIENT_ID", "CLIENT_SECRET"]
                .iter()
                .any(|s| key == format!("FORGE_{p}_{s}"))
        })
}
pub fn preview_peer(env: &Env) -> Option<String> {
    if value(env, "FORGE_RESOURCE_PROFILE") != "preview" || value(env, "VERCEL_ENV") != "preview" {
        return None;
    }
    let p = &POLICY["preview"];
    let peer = match value(env, "VERCEL_PROJECT_ID") {
        id if id == field(p, "webProjectId") => field(p, "runtimeProjectId"),
        id if id == field(p, "runtimeProjectId") => field(p, "webProjectId"),
        _ => return None,
    };
    let data: Value = serde_json::from_str(value(env, "VERCEL_RELATED_PROJECTS")).ok()?;
    let matches: Vec<_> = data
        .as_array()?
        .iter()
        .filter(|v| v["project"]["id"] == peer)
        .collect();
    if matches.len() != 1 {
        return None;
    }
    let host = matches[0]["preview"]["branch"].as_str()?;
    let prefix = host.strip_suffix(".vercel.app")?;
    if prefix.is_empty()
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return None;
    }
    Some(format!("https://{host}"))
}
fn database(env: &Env, policy: &Value, host: &str) -> bool {
    let Ok(url) = Url::parse(value(env, "DATABASE_URL")) else {
        return false;
    };
    let mut bytes = Vec::new();
    let mut path = url.path().strip_prefix('/').unwrap_or(url.path()).bytes();
    while let Some(b) = path.next() {
        if b == b'%' {
            let Some(a) = path.next().and_then(|a| (a as char).to_digit(16)) else {
                return false;
            };
            let Some(b) = path.next().and_then(|b| (b as char).to_digit(16)) else {
                return false;
            };
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(b);
        }
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    ["postgres", "postgresql"].contains(&url.scheme())
        && url.host_str() == Some(host)
        && url.username() == field(policy, "databaseRole")
        && bytes == field(&policy["database"], "database").as_bytes()
        && url.port().is_none_or(|p| p == 5432)
        && url.fragment().is_none_or(str::is_empty)
        && pairs
            .iter()
            .find(|(k, _)| k == "sslmode")
            .is_some_and(|(_, v)| ["require", "verify-full"].contains(&v.as_ref()))
        && pairs.iter().all(|(k, _)| {
            ["sslmode", "channel_binding"].contains(&k.as_ref())
                && pairs.iter().filter(|(other, _)| other == k).count() == 1
        })
}
pub fn validate(env: &Env, service: &str) -> Result<(), ContractError> {
    let invalid = ContractError("deployment isolation configuration");
    if !["web", "runtime"].contains(&service) {
        return Err(invalid);
    }
    let web = service == "web";
    let p = &POLICY["preview"];
    let project = value(env, "VERCEL_PROJECT_ID");
    if value(env, "FORGE_RESOURCE_PROFILE") == "preview"
        || project == field(p, "runtimeProjectId")
        || (project == field(p, "webProjectId") && value(env, "VERCEL_ENV") == "preview")
    {
        if value(env, "FORGE_RESOURCE_PROFILE") != "preview"
            || value(env, "VERCEL_ENV") != "preview"
            || project
                != field(
                    p,
                    if web {
                        "webProjectId"
                    } else {
                        "runtimeProjectId"
                    },
                )
            || preview_peer(env).is_none()
            || value(env, "FORGE_ENVIRONMENT") != "staging"
            || value(env, "FORGE_EXTERNAL_INTEGRATIONS") != "disabled"
            || value(env, "EVE_EVAL_FIXTURE_MODE") == "true"
            || value(env, "AGENT_FAKE_RUNTIME_ENABLED") == "true"
            || env.iter().any(|(k, v)| !v.is_empty() && credential(k))
            || value(env, "FORGE_AGENT_CHANNEL_SECRET")
                .encode_utf16()
                .count()
                < 32
        {
            return Err(invalid);
        }
        if !web {
            return Ok(());
        }
        if !value(env, "BETTER_AUTH_URL").is_empty()
            || !value(env, "EVE_AGENT_RUNTIME_URL").is_empty()
            || value(env, "FORGE_AGENT_BLOB_ADAPTER") != "vercel-private"
            || value(env, "BLOB_STORE_ID") != field(p, "blobStoreId")
            || [
                "FORGE_BILLING_ENABLED",
                "FORGE_BILLING_WEBHOOKS_ENABLED",
                "FORGE_CALLS_ENABLED",
            ]
            .iter()
            .any(|k| value(env, k) != "false")
            || !database(env, p, field(&p["database"], "host"))
        {
            return Err(invalid);
        }
        return Ok(());
    }
    let p = &POLICY["staging"];
    if value(env, "FORGE_ENVIRONMENT") != "staging"
        && ![field(p, "webProjectId"), field(p, "runtimeProjectId")].contains(&project)
    {
        return Ok(());
    }
    let sandbox = value(env, "FORGE_EXTERNAL_INTEGRATIONS") == "sandbox";
    if (value(env, "VERCEL") == "1"
        && project
            != field(
                p,
                if web {
                    "webProjectId"
                } else {
                    "runtimeProjectId"
                },
            ))
        || value(env, "FORGE_ENVIRONMENT") != "staging"
        || !["disabled", "sandbox"].contains(&value(env, "FORGE_EXTERNAL_INTEGRATIONS"))
        || value(env, "EVE_EVAL_FIXTURE_MODE") == "true"
    {
        return Err(invalid);
    }
    for (k, v) in env {
        if !v.is_empty()
            && credential(k)
            && (!web
                || !sandbox
                || POLICY["digests"][k].as_str()
                    != Some(&hex::encode(Sha256::digest(v.as_bytes()))))
        {
            return Err(invalid);
        }
    }
    if sandbox {
        let i = &POLICY["integrations"];
        if !web
            || (!value(env, "OPENAI_API_KEY").is_empty()
                && value(env, "FORGE_MANAGED_OPENAI_MODELS") != field(i, "openaiModel"))
            || (!value(env, "RESEND_API_KEY").is_empty()
                && value(env, "RESEND_FROM_EMAIL") != field(i, "mailFrom"))
            || (!value(env, "POLAR_ACCESS_TOKEN").is_empty()
                && value(env, "POLAR_ENVIRONMENT") != "sandbox")
            || ["GOOGLE_MEET", "ZOOM"].iter().any(|p| {
                value(env, &format!("FORGE_{p}_CLIENT_ID")).is_empty()
                    != value(env, &format!("FORGE_{p}_CLIENT_SECRET")).is_empty()
            })
        {
            return Err(invalid);
        }
    }
    if value(env, "FORGE_AGENT_CHANNEL_SECRET")
        .encode_utf16()
        .count()
        < 32
    {
        return Err(invalid);
    }
    if !web {
        return if value(env, "FORGE_APP_ORIGIN") == field(p, "webOrigin") {
            Ok(())
        } else {
            Err(invalid)
        };
    }
    if value(env, "BETTER_AUTH_URL") != field(p, "webOrigin")
        || value(env, "EVE_AGENT_RUNTIME_URL") != field(p, "runtimeOrigin")
        || value(env, "FORGE_AGENT_BLOB_ADAPTER") != "vercel-private"
        || value(env, "BLOB_STORE_ID") != field(p, "blobStoreId")
        || ["FORGE_BILLING_ENABLED", "FORGE_BILLING_WEBHOOKS_ENABLED"]
            .iter()
            .any(|k| value(env, k) != "false")
        || !database(
            env,
            p,
            &field(&p["database"], "host").replacen('.', "-pooler.", 1),
        )
    {
        return Err(invalid);
    }
    Ok(())
}
