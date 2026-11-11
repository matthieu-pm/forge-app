use super::*;
use crate::contract::*;
use serde_json::{Value, json};
use std::collections::HashMap;
pub const CHECKS: &[&str] = &[
    "current-authorization",
    "capability-scopes-and-write-approvals",
    "provider-credentials-and-revocation",
    "provider-release",
    "original-deadline-and-token-bounds",
    "disconnect-reconnect-single-owner",
    "cancel-and-unknown-outcome-reconciliation",
    "sandbox-isolation",
    "atomic-allowance-reservation-and-settlement",
];
pub const FLAGS: &[&str] = &[
    "agent_ui",
    "agent_eve_runtime",
    "agent_code_mode",
    "agent_programmatic_tools",
    "agent_write_tools",
    "agent_skills",
    "agent_model_connections",
    "agent_auto_openai",
    "agent_codex_local",
    "agent_claude_local_beta",
    "agent_provider_openai",
    "agent_provider_anthropic",
    "agent_provider_google",
    "agent_provider_minimax",
    "agent_provider_mistral",
    "agent_provider_xai",
    "agent_provider_deepseek",
    "agent_provider_kimi",
    "agent_provider_custom_openai",
    "agent_provider_custom_anthropic",
];
pub fn features(env: &HashMap<String, String>) -> Value {
    Value::Object(
        FLAGS
            .iter()
            .map(|name| {
                let key = format!("FORGE_FEATURE_{}", name.to_uppercase());
                let fallback = !["agent_skills", "agent_claude_local_beta"].contains(name);
                let value = env
                    .get(&key)
                    .filter(|v| !v.is_empty())
                    .map_or(fallback, |v| {
                        !["0", "false", "off", "no"]
                            .contains(&crate::text::trim(v).to_lowercase().as_str())
                    });
                ((*name).into(), json!(value))
            })
            .collect(),
    )
}
pub fn provider_enabled(flags: &Value, provider: &str) -> bool {
    PROVIDERS.contains(&provider)
        && flags[format!("agent_provider_{}", provider.replace('-', "_"))] == true
}
pub(super) fn positive(value: Option<&String>) -> Option<f64> {
    let value = crate::text::trim(value?);
    let n = if let Some(raw) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        {
            if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            u64::from_str_radix(raw, 16).ok()? as f64
        }
    } else if let Some(raw) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        {
            if raw.is_empty() || !raw.chars().all(|c| c.is_digit(2)) {
                return None;
            }
            u64::from_str_radix(raw, 2).ok()? as f64
        }
    } else if let Some(raw) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        {
            if raw.is_empty() || !raw.chars().all(|c| c.is_digit(8)) {
                return None;
            }
            u64::from_str_radix(raw, 8).ok()? as f64
        }
    } else {
        value.parse::<f64>().ok()?
    };
    (n > 0. && n <= 9007199254740991. && n.fract() == 0.).then_some(n)
}
fn allowlist(value: Option<&String>) -> Value {
    let mut items = Vec::new();
    for item in value.into_iter().flat_map(|v| v.split(',')) {
        let item = crate::text::trim(item).to_lowercase();
        if !item.is_empty() && !items.contains(&item) {
            items.push(item);
        }
    }
    if items.is_empty() {
        Value::Null
    } else {
        json!(items)
    }
}
pub fn controls(env: &HashMap<String, String>) -> Value {
    json!({"runWallClockMs":positive(env.get("FORGE_AGENT_RUN_WALL_CLOCK_MS")).unwrap_or(900000.).min(900000.) as i64,"maxInputTokens":positive(env.get("FORGE_AGENT_MAX_INPUT_TOKENS")).unwrap_or(200000.).min(200000.) as i64,"maxOutputTokens":positive(env.get("FORGE_AGENT_MAX_OUTPUT_TOKENS")).unwrap_or(50000.).min(50000.) as i64,"userMonthlyBudgetMicros":positive(env.get("FORGE_AGENT_USER_MONTHLY_BUDGET_MICROS")).map(|n|n as i64),"workspaceMonthlyBudgetMicros":positive(env.get("FORGE_AGENT_WORKSPACE_MONTHLY_BUDGET_MICROS")).map(|n|n as i64),"allowedProviders":allowlist(env.get("FORGE_AGENT_ALLOWED_PROVIDERS")),"allowedCapabilities":allowlist(env.get("FORGE_AGENT_ALLOWED_CAPABILITIES"))})
}
pub fn budget(policy: &Value, user_cost: f64, workspace_cost: f64) -> Option<&'static str> {
    if policy["userMonthlyBudgetMicros"]
        .as_f64()
        .is_some_and(|n| user_cost >= n)
    {
        Some("Your monthly Forge Agent budget has been reached.")
    } else if policy["workspaceMonthlyBudgetMicros"]
        .as_f64()
        .is_some_and(|n| workspace_cost >= n)
    {
        Some("This workspace's monthly Forge Agent budget has been reached.")
    } else {
        None
    }
}
pub fn provider(input: &Value) -> Result<Value> {
    enumeration(input["provider"].clone(), PROVIDERS)?;
    enumeration(input["billingMode"].clone(), BILLING)?;
    let funded = input["billingMode"] == "forge-managed";
    Ok(
        json!({"eligible":!funded || !input["provider"].as_str().unwrap().starts_with("custom-"),"payer":if funded{"forge"}else{"customer-provider"},"allowance":if funded{"workspace-ai-pool"}else{"excluded"},"overage":if funded{"explicit-capped-at-cost"}else{"excluded"},"pricing":if funded{"bounded-verified-quote"}else{"provider-direct"},"concurrency":{"user":null,"workspace":null,"provider":null}}),
    )
}
const CANDIDATE: &[&str] = &[
    "sourceRevision",
    "environment",
    "provider",
    "modelId",
    "billingMode",
    "executionKind",
    "locality",
];
fn label(v: Value) -> Result<Value> {
    text(v, 1, 1000, true)
}
fn fingerprint(v: Value) -> Result<Value> {
    pattern(v, "^[a-f0-9]{64}$")
}
fn artifact(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["reference", "sha256"], true)?;
    o.required("reference", label)?;
    o.required("sha256", fingerprint)?;
    Ok(o.finish())
}
fn candidate_fields(o: &mut Object) -> Result<()> {
    o.required("sourceRevision", |v| pattern(v, "^[a-f0-9]{40}$"))?;
    o.required("environment", |v| {
        let mut o = Object::new(v, &["name", "webDeploymentId", "runtimeDeploymentId"], true)?;
        for key in ["name", "webDeploymentId", "runtimeDeploymentId"] {
            o.required(key, label)?;
        }
        Ok(o.finish())
    })?;
    o.required("provider", |v| enumeration(v, PROVIDERS))?;
    o.required("modelId", label)?;
    o.required("billingMode", |v| enumeration(v, BILLING))?;
    o.required("executionKind", |v| enumeration(v, EXECUTIONS))?;
    o.required("locality", |v| enumeration(v, LOCALITIES))?;
    Ok(())
}
pub fn candidate(v: Value) -> Result<Value> {
    let mut o = Object::new(v, CANDIDATE, true)?;
    candidate_fields(&mut o)?;
    Ok(o.finish())
}
pub fn evidence(v: Value) -> Result<Value> {
    let enabled = v["enabled"].as_bool().ok_or(ContractError("enabled"))?;
    let keys = [
        CANDIDATE,
        &["policyVersion", "enabled"],
        if enabled {
            &[
                "kind",
                "operator",
                "observedAt",
                "configuration",
                "executionOwner",
                "limits",
                "codeEnabled",
                "sandbox",
                "pricing",
                "checks",
            ][..]
        } else {
            &["reason"]
        },
    ]
    .concat();
    let mut o = Object::new(v, &keys, true)?;
    candidate_fields(&mut o)?;
    o.required("enabled", boolean)?;
    o.required("policyVersion", |v| number(v, 1., 1., true))?;
    if !enabled {
        o.required("reason", label)?;
        return Ok(o.finish());
    }
    o.required("kind", |v| enumeration(v, &["deployed", "fixture"]))?;
    o.required("operator", label)?;
    o.required("observedAt", datetime)?;
    o.required("configuration", artifact)?;
    o.required("executionOwner", |v| {
        enumeration(
            v,
            &[
                "durable-runtime",
                "durable-worker",
                "local-process",
                "unknown",
            ],
        )
    })?;
    o.required("limits", |v| {
        let mut o = Object::new(
            v,
            &["runWallClockMs", "maxInputTokens", "maxOutputTokens"],
            true,
        )?;
        for (key, max) in [
            ("runWallClockMs", 900000.),
            ("maxInputTokens", 200000.),
            ("maxOutputTokens", 50000.),
        ] {
            o.required(key, |v| number(v, 1., max, true))?;
        }
        Ok(o.finish())
    })?;
    o.required("codeEnabled", boolean)?;
    o.required("sandbox", |v| {
        enumeration(
            v,
            &[
                "isolated-hosted-deny-network",
                "local-process",
                "unknown",
                "disabled",
            ],
        )
    })?;
    o.required("pricing", |v| {
        let known = match v["status"].as_str() {
            Some("unknown") => false,
            Some("verified-bound") => true,
            _ => return Err(ContractError("pricing")),
        };
        let mut o = Object::new(
            v,
            if known {
                &[
                    "status",
                    "maximumCostUsdMicros",
                    "fingerprint",
                    "validFrom",
                    "expiresAt",
                    "artifact",
                ]
            } else {
                &["status"]
            },
            true,
        )?;
        o.required("status", |v| enumeration(v, &["unknown", "verified-bound"]))?;
        if known {
            o.required("maximumCostUsdMicros", |v| {
                number(v, 1., 9007199254740991., true)
            })?;
            o.required("fingerprint", fingerprint)?;
            for key in ["validFrom", "expiresAt"] {
                o.required(key, datetime)?;
            }
            o.required("artifact", artifact)?;
        }
        Ok(o.finish())
    })?;
    o.required("checks", |v| {
        list(v, 0, usize::MAX, |v| {
            let mut o = Object::new(v, &["name", "result", "artifact"], true)?;
            o.required("name", |v| enumeration(v, CHECKS))?;
            o.required("result", |v| {
                enumeration(v, &["passed", "failed", "not-run"])
            })?;
            o.required("artifact", artifact)?;
            Ok(o.finish())
        })
    })?;
    Ok(o.finish())
}
pub fn assess(raw: Value, expected: Value) -> Value {
    let (Ok(expected), Ok(e)) = (candidate(expected), evidence(raw)) else {
        return json!({"status":"insufficient-evidence","problems":["Invalid or missing candidate/policy evidence"]});
    };
    let mut problems = vec![];
    for key in [
        "sourceRevision",
        "provider",
        "modelId",
        "billingMode",
        "executionKind",
        "locality",
    ] {
        if e[key] != expected[key] {
            problems.push(format!("Candidate {key} mismatch"));
        }
    }
    for key in ["name", "webDeploymentId", "runtimeDeploymentId"] {
        if e["environment"][key] != expected["environment"][key] {
            problems.push(format!("Candidate environment {key} mismatch"));
        }
    }
    if !problems.is_empty() {
        return json!({"status":"insufficient-evidence","problems":problems});
    }
    if e["enabled"] == false {
        return json!({"status":"disabled","problems":[]});
    }
    let policy = provider(&e).unwrap();
    if policy["eligible"] == false {
        problems.push("Custom Forge-funded providers have no accepted funding policy".into());
    }
    if e["kind"] != "deployed" {
        problems.push("Fixture evidence cannot enable production".into());
    }
    if e["executionKind"] == "forge-native" {
        if e["locality"] != "server-capable"
            || !["durable-runtime", "durable-worker"]
                .contains(&e["executionOwner"].as_str().unwrap())
        {
            problems.push("Hosted runs require a durable execution owner".into());
        }
    } else if e["locality"] != "local-only"
        || e["executionOwner"] != "local-process"
        || policy["payer"] == "forge"
    {
        problems.push("External agents require customer-paid local execution ownership".into());
    }
    if e["codeEnabled"] == true && e["sandbox"] != "isolated-hosted-deny-network" {
        problems.push("Code requires an isolated hosted sandbox with deny-all network".into());
    }
    if policy["payer"] == "forge" && e["pricing"]["status"] != "verified-bound" {
        problems.push("Forge-funded usage requires a verified positive bounded quote".into());
    }
    if e["pricing"]["status"] == "verified-bound" {
        let time = |v: &Value| {
            v.as_str()
                .unwrap()
                .parse::<chrono::DateTime<chrono::Utc>>()
                .unwrap()
                .timestamp_millis()
        };
        let observed = time(&e["observedAt"]);
        if observed < time(&e["pricing"]["validFrom"])
            || observed >= time(&e["pricing"]["expiresAt"])
        {
            problems.push("Pricing quote is not valid at the evidence observation time".into());
        }
    }
    let mut names = std::collections::HashSet::new();
    for check in e["checks"].as_array().unwrap() {
        let name = check["name"].as_str().unwrap();
        if !names.insert(name) {
            problems.push(format!("Duplicate check: {name}"));
        }
        if check["result"] != "passed" {
            problems.push(format!("Unverified check: {name}"));
        }
    }
    for name in CHECKS {
        if (*name != "sandbox-isolation" || e["codeEnabled"] == true)
            && (*name != "atomic-allowance-reservation-and-settlement"
                || policy["payer"] == "forge")
            && !names.contains(name)
        {
            problems.push(format!("Missing check: {name}"));
        }
    }
    json!({"status":if problems.is_empty(){"eligible-for-review"}else{"insufficient-evidence"},"problems":problems})
}
