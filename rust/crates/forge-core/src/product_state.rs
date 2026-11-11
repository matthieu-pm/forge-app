//! Generic state stays owner-scoped; recovery protocols inspect only declared IDs.
pub use crate::contract::ContractError as StateError;
use crate::{canonical::javascript_stringify, comments::truthy, contract::*};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};
pub mod copies;
pub const PROJECT_COMMAND: &str = "forge:project-command:v1:";
pub const INITIATIVE_COMMAND: &str = "forge:initiative-command:v1:";
pub fn capture(key: &str, pattern: &'static str) -> Option<String> {
    static PATTERNS: OnceLock<Mutex<HashMap<&'static str, Arc<regex::Regex>>>> = OnceLock::new();
    let regex = PATTERNS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(pattern)
        .or_insert_with(|| Arc::new(regex::Regex::new(pattern).expect("constant key pattern")))
        .clone();
    regex.captures(key).map(|v| {
        v.get(1)
            .unwrap_or_else(|| v.get(0).unwrap())
            .as_str()
            .to_owned()
    })
}
pub fn product_key(key: &str) -> bool {
    key.starts_with("forge:")
        || key.starts_with("forge.")
        || crate::json::parse(key).ok().is_some_and(|v| {
            v.as_array()
                .is_some_and(|a| a.first().is_some_and(|v| v == "forge.preferences"))
        })
}
pub fn command(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "workspaceId",
            "sessionId",
            "commandKey",
            "key",
            "value",
            "expectedRevision",
        ],
        true,
    )?;
    for k in ["workspaceId", "sessionId"] {
        o.required(k, |v| text(v, 1, usize::MAX, false))?;
    }
    o.required("commandKey", uuid)?;
    o.required("key", |v| {
        let v = text(v, 1, 500, false)?;
        if product_key(v.as_str().unwrap()) {
            Ok(v)
        } else {
            Err(ContractError("product namespace"))
        }
    })?;
    o.required("value", |v| nullable(v, |v| text(v, 0, 20_000_000, false)))?;
    o.required("expectedRevision", integer)?;
    Ok(o.finish())
}
pub fn workspace_key(key: &str) -> Option<String> {
    capture(key, r"^forge:workspace:([^:]+):")
        .or_else(|| capture(key, r"^forge:project-statuses:v1:([^:]+)$"))
}
pub fn team_key(key: &str) -> Option<String> {
    capture(key,r"^forge:(?:team-[^:]+|cycle-issues|triage-issues|triage-draft):v1:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$").or_else(||capture(key,r"^forge:team-issue-labels:([0-9a-f-]{36}):v1$"))
}
pub fn post_project(key: &str) -> Option<String> {
    capture(key, r"^forge:project-post-draft:v1:([0-9a-f-]{36})$")
}
pub fn shared_initiatives(workspace: &str) -> String {
    format!("forge:workspace:{workspace}:shared-initiatives:v1")
}
pub fn initiative_settings(workspace: &str) -> String {
    format!("forge:workspace:{workspace}:initiatives-settings:v1")
}
pub fn catalog_kind<'a>(key: &str, workspace: &str) -> Option<&'a str> {
    if key == format!("forge:project-statuses:v1:{workspace}") {
        Some("statuses")
    } else if key == "forge:workspace-project-labels:v1" {
        Some("labels")
    } else {
        None
    }
}
pub fn shared(key: &str, workspace: &str) -> bool {
    key == initiative_settings(workspace)
        || catalog_kind(key, workspace).is_some()
        || capture(
            key,
            r"^forge:team-(?:cycles|triage|project-updates|thread-summaries):v1:",
        )
        .is_some()
}
pub fn feature(key: &str) -> Option<crate::features::ProductFeature> {
    use crate::features::ProductFeature as F;
    for (pattern, feature) in [
        (
            r"^forge:(?:signals|signal-documents|signals-sidebar-width):",
            F::Signals,
        ),
        (
            r"^forge:(?:reviews?(?:-display|-preview|-edits)?|code-reviews):",
            F::Reviews,
        ),
        (r"^forge:workspace:[^:]+:sla-settings(?:$|:)", F::Sla),
        (
            r"^forge:(?:agent-personalization|team-agent-skills):",
            F::AgentGuidance,
        ),
        (
            r"^forge:workspace:[^:]+:project-updates-settings(?:$|:)",
            F::ScheduledUpdates,
        ),
        (r"^forge:team-project-updates:", F::ScheduledUpdates),
        (r"^forge:team-thread-summaries:", F::ThreadSummaries),
    ] {
        if capture(key, pattern).is_some() {
            return Some(feature);
        }
    }
    None
}
fn parse(raw: &str) -> Result<Value> {
    crate::json::parse(raw).map_err(|_| ContractError("saved copy"))
}
fn object(raw: &str) -> Result<Value> {
    let v = parse(raw)?;
    if v.is_object() {
        Ok(v)
    } else {
        Err(ContractError("saved copy"))
    }
}
fn target(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| crate::text::is_uuid(s))
        .map(str::to_ascii_lowercase)
}
fn nested(data: &Value) -> Result<(&str, Option<&str>)> {
    let key = data["key"].as_str().ok_or(ContractError("recovery copy"))?;
    let v = data.get("value").ok_or(ContractError("recovery copy"))?;
    if v.is_null() {
        Ok((key, None))
    } else {
        Ok((key, Some(v.as_str().ok_or(ContractError("recovery copy"))?)))
    }
}
fn wrapper(key: &str) -> bool {
    key.starts_with("forge:pending-recovery:v1:") || key.starts_with("forge:legacy-conflict:v1:")
}
fn bounded(depth: usize) -> Result<()> {
    if depth > 8 {
        Err(ContractError("Saved recovery nesting exceeds its limit."))
    } else {
        Ok(())
    }
}
