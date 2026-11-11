//! Shared SLA policy boundaries. Deadlines and lifecycle transitions remain in
//! Forge's authoritative PostgreSQL engine, preserving existing commitments.
use crate::contract::list as array;
use crate::contract::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub fn duration(v: Value) -> Result<Value> {
    let max = match v["unit"].as_str() {
        Some("hour") => 8760.,
        Some("day" | "business-day") => 365.,
        Some("week") => 52.,
        _ => return Err(ContractError("duration")),
    };
    let mut o = Object::new(v, &["unit", "value"], true)?;
    o.required("unit", |v| {
        enumeration(v, &["hour", "day", "business-day", "week"])
    })?;
    o.required("value", |v| number(v, 1., max, true))?;
    Ok(o.finish())
}
fn filters(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["teamIds", "priorities", "statuses"], true)?;
    o.optional("teamIds", |v| array(v, 1, 100, uuid))?;
    o.optional("priorities", |v| {
        array(v, 1, 5, |v| {
            enumeration(v, &["Urgent", "High", "Medium", "Low", "No priority"])
        })
    })?;
    o.optional("statuses", |v| {
        array(v, 1, 100, |v| {
            let mut o = Object::new(v, &["teamId", "statusId"], true)?;
            o.required("teamId", uuid)?;
            o.required("statusId", |v| text(v, 1, 255, false))?;
            Ok(o.finish())
        })
    })?;
    let v = o.finish();
    if v.as_object().is_none_or(|o| o.is_empty()) {
        return Err(ContractError("condition"));
    }
    Ok(v)
}
pub fn rule(v: Value) -> Result<Value> {
    let apply = match v["action"].as_str() {
        Some("apply") => true,
        Some("remove") => false,
        _ => return Err(ContractError("action")),
    };
    let mut o = Object::new(
        v,
        if apply {
            &[
                "id",
                "enabled",
                "filters",
                "action",
                "duration",
                "startMode",
            ]
        } else {
            &["id", "enabled", "filters", "action"]
        },
        true,
    )?;
    o.required("id", uuid)?;
    o.required("enabled", boolean)?;
    o.required("filters", filters)?;
    o.required("action", |v| enumeration(v, &["apply", "remove"]))?;
    if apply {
        o.required("duration", duration)?;
        o.required("startMode", |v| {
            enumeration(v, &["ruleMatch", "issueCreation"])
        })?;
    }
    Ok(o.finish())
}
pub fn policy(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["enabled", "workWeek", "rules"], true)?;
    o.required("enabled", boolean)?;
    o.required("workWeek", |v| enumeration(v, &["mon-fri", "sun-thu"]))?;
    o.required("rules", |v| array(v, 0, 100, rule))?;
    let v = o.finish();
    let rules = v["rules"].as_array().unwrap();
    if rules
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect::<HashSet<_>>()
        .len()
        != rules.len()
    {
        return Err(ContractError("rule identities"));
    }
    Ok(v)
}
pub fn initial() -> Value {
    json!({"enabled":false,"workWeek":"mon-fri","rules":[]})
}
pub fn read(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["workspaceId", "sessionId"], true)?;
    for key in ["workspaceId", "sessionId"] {
        o.required(key, |v| text(v, 1, usize::MAX, false))?;
    }
    Ok(o.finish())
}
pub fn command(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "workspaceId",
            "sessionId",
            "commandKey",
            "expectedRevision",
            "values",
        ],
        true,
    )?;
    for key in ["workspaceId", "sessionId"] {
        o.required(key, |v| text(v, 1, 255, false))?;
    }
    o.required("commandKey", uuid)?;
    o.required("expectedRevision", integer)?;
    o.required("values", policy)?;
    Ok(o.finish())
}
pub fn reconciliation(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "workspaceId",
            "sessionId",
            "commandKey",
            "commitmentId",
            "expectedVersion",
            "decision",
            "evidence",
        ],
        true,
    )?;
    for key in ["workspaceId", "sessionId"] {
        o.required(key, |v| text(v, 1, usize::MAX, false))?;
    }
    for key in ["commandKey", "commitmentId"] {
        o.required(key, uuid)?;
    }
    // JavaScript's $ anchor accepts a final newline; keep this boundary identical.
    o.required("expectedVersion", |v| {
        let s = v.as_str().ok_or(ContractError("version"))?;
        if regress::Regex::new("^[a-f0-9]{64}$")
            .unwrap()
            .find(s)
            .is_none()
        {
            return Err(ContractError("version"));
        }
        Ok(v)
    })?;
    o.required("decision", |v| enumeration(v, &["breach-owed", "not-owed"]))?;
    o.required("evidence", |v| text(v, 10, 500, true))?;
    Ok(o.finish())
}
pub fn gate_identity(deployment: &str, workspace: &str, enabled: bool) -> String {
    format!(
        "{:x}",
        Sha256::digest(crate::canonical::javascript_stringify(
            &json!({"deployment":deployment,"workspaceId":workspace,"enabled":enabled})
        ))
    )
}
pub fn reconciliation_version(
    id: &str,
    previous_gate: &str,
    classified: Option<&str>,
    owed: Option<&str>,
    current_gate: &str,
) -> String {
    format!(
        "{:x}",
        Sha256::digest(crate::canonical::javascript_stringify(&json!([
            id,
            previous_gate,
            classified,
            owed,
            current_gate
        ])))
    )
}
