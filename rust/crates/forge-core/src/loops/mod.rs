//! Shared-loop contracts, trigger matching and calendar rules. These are the
//! reference application's published rules; storage and execution own authority.
use crate::contract::*;
use serde_json::{Value, json};

mod matching;
mod schedule;
pub use matching::{matches_conditions, matches_event};
pub use schedule::{iso_timestamp, local_date_time, next_scheduled_at, schedule_start};

pub const ENTITIES: &[&str] = &["issue", "project", "initiative", "cycle", "team"];
pub const FIELDS: &[&str] = &[
    "id",
    "title",
    "name",
    "status",
    "priority",
    "assignee",
    "creator",
    "agent",
    "project",
    "cycle",
    "team",
    "labels",
    "owner",
    "lead",
    "targetDate",
    "description",
    "projects",
    "members",
    "triage",
    "milestones",
];
pub const EVENTS: &[&str] = &[
    "created",
    "updated",
    "changed",
    "added",
    "removed",
    "comment",
    "update",
    "triage",
    "started",
    "completed",
];
pub fn event_properties(entity: &str) -> &'static [&'static str] {
    match entity {
        "issue" => &[
            "status", "priority", "assignee", "agent", "project", "cycle", "team", "labels",
        ],
        "project" => &[
            "status",
            "lead",
            "priority",
            "labels",
            "targetDate",
            "description",
            "milestones",
        ],
        "initiative" => &["status", "owner", "projects", "targetDate", "description"],
        "team" => &["members"],
        _ => &[],
    }
}
pub fn condition_fields(entity: &str) -> &'static [&'static str] {
    match entity {
        "issue" => &[
            "id",
            "title",
            "description",
            "status",
            "priority",
            "assignee",
            "creator",
            "agent",
            "project",
            "cycle",
            "team",
            "labels",
            "triage",
        ],
        "project" => &[
            "id",
            "name",
            "description",
            "status",
            "priority",
            "lead",
            "creator",
            "team",
            "labels",
            "targetDate",
            "members",
        ],
        "initiative" => &[
            "id",
            "name",
            "description",
            "status",
            "priority",
            "owner",
            "creator",
            "projects",
            "targetDate",
        ],
        "cycle" => &["id", "name", "team"],
        "team" => &["id", "name", "members"],
        _ => &[],
    }
}
pub fn leaf(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["field", "operator", "values"], true)?;
    o.required("field", |v| enumeration(v, FIELDS))?;
    o.required("operator", |v| {
        enumeration(v, &["is", "isNot", "any", "none", "contains"])
    })?;
    o.required("values", |v| list(v, 1, 50, |v| text(v, 1, 1000, false)))?;
    let v = o.finish();
    if v["operator"] == "contains" {
        let values = v["values"].as_array().unwrap();
        if values.len() != 1 || crate::text::trim(values[0].as_str().unwrap()).is_empty() {
            return Err(ContractError("text condition"));
        }
    }
    Ok(v)
}
pub fn condition(v: Value) -> Result<Value> {
    condition_at(v, 0)
}
fn condition_at(v: Value, depth: usize) -> Result<Value> {
    if v.get("conditions").is_none() || depth >= 4 {
        return leaf(v);
    }
    let mut o = Object::new(v, &["operator", "conditions"], true)?;
    o.required("operator", |v| enumeration(v, &["and", "or"]))?;
    o.required("conditions", |v| {
        list(v, 1, 8, |v| condition_at(v, depth + 1))
    })?;
    Ok(o.finish())
}
pub fn condition_leaves(conditions: &[Value]) -> Vec<&Value> {
    conditions
        .iter()
        .flat_map(|c| match c["conditions"].as_array() {
            Some(children) => condition_leaves(children),
            None => vec![c],
        })
        .collect()
}
pub fn trigger(v: Value) -> Result<Value> {
    match v["kind"].as_str() {
        Some("webhook") => Ok(Object::new(v, &["kind"], true)?.finish()),
        Some("schedule") => schedule::contract(v),
        Some("event") => event_trigger(v),
        _ => Err(ContractError("trigger kind")),
    }
}
fn event_trigger(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "kind",
            "entity",
            "event",
            "property",
            "values",
            "commentMode",
            "commentText",
            "mentionIds",
        ],
        true,
    )?;
    o.required("entity", |v| enumeration(v, ENTITIES))?;
    o.required("event", |v| enumeration(v, EVENTS))?;
    o.optional("property", |v| enumeration(v, FIELDS))?;
    o.optional("values", |v| list(v, 0, 50, |v| text(v, 0, 1000, false)))?;
    o.optional("commentMode", |v| {
        enumeration(v, &["any", "newThread", "contains", "mentions"])
    })?;
    o.optional("commentText", |v| text(v, 1, 1000, true))?;
    o.optional("mentionIds", |v| list(v, 1, 50, |v| text(v, 1, 200, false)))?;
    let v = o.finish();
    let entity = v["entity"].as_str().unwrap();
    let event = v["event"].as_str().unwrap();
    let property = v["property"].as_str().unwrap_or_default();
    let valid_property = match event {
        "changed" => event_properties(entity).contains(&property),
        "added" | "removed" => {
            ["issue", "project", "team"].contains(&entity)
                && property
                    == if entity == "team" {
                        "members"
                    } else {
                        "labels"
                    }
        }
        _ => v.get("property").is_none() && v.get("values").is_none(),
    };
    let valid_entity = match event {
        "update" => ["project", "initiative"].contains(&entity),
        "triage" => entity == "issue",
        "started" | "completed" => entity == "cycle",
        "comment" | "updated" => ["issue", "project", "initiative"].contains(&entity),
        _ => true,
    };
    let valid_comment = if event == "comment" {
        (v["commentMode"] == "contains") == v.get("commentText").is_some()
            && (v["commentMode"] == "mentions") == v.get("mentionIds").is_some()
    } else {
        ["commentMode", "commentText", "mentionIds"]
            .iter()
            .all(|key| v.get(key).is_none())
    };
    if !valid_property || !valid_entity || !valid_comment {
        return Err(ContractError("trigger combination"));
    }
    Ok(v)
}
pub fn fields(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "name",
            "description",
            "instructions",
            "trigger",
            "conditions",
            "reasoning",
            "teamAccess",
        ],
        true,
    )?;
    o.required("name", |v| text(v, 1, 64, true))?;
    o.required("description", |v| text(v, 0, 255, true))?;
    o.required("instructions", |v| text(v, 1, 20000, true))?;
    o.required("trigger", trigger)?;
    o.required("conditions", |v| list(v, 0, 8, condition))?;
    o.required("reasoning", |v| {
        enumeration(v, &["auto", "low", "medium", "high"])
    })?;
    o.required("teamAccess", |v| {
        enumeration(v, &["this-team", "all-public-teams"])
    })?;
    let v = o.finish();
    let leaves = condition_leaves(v["conditions"].as_array().unwrap());
    let supported = condition_fields(v["trigger"]["entity"].as_str().unwrap_or_default());
    if leaves.len() > 8
        || leaves
            .iter()
            .any(|c| !supported.contains(&c["field"].as_str().unwrap()))
    {
        return Err(ContractError("conditions for trigger"));
    }
    Ok(v)
}
pub fn command(v: Value) -> Result<Value> {
    let action = v["action"]
        .as_str()
        .ok_or(ContractError("action"))?
        .to_owned();
    let mut keys = vec!["action", "id"];
    match action.as_str() {
        "create" => keys.push("fields"),
        "save" => keys.extend(["expectedRevision", "fields"]),
        "delete" | "enable" | "disable" | "rotate-webhook" => keys.push("expectedRevision"),
        "approve" | "deny" => keys.extend(["expectedRevision", "runId", "approvalId", "inputHash"]),
        "cancel-run" => keys.extend(["expectedRevision", "runId"]),
        "run-now" => keys.extend(["expectedRevision", "entityId"]),
        _ => return Err(ContractError("action")),
    }
    let mut o = Object::new(v, &keys, true)?;
    o.required("id", uuid)?;
    if action != "create" {
        o.required("expectedRevision", integer)?;
    }
    if ["create", "save"].contains(&action.as_str()) {
        o.required("fields", fields)?;
    }
    if ["approve", "deny", "cancel-run"].contains(&action.as_str()) {
        o.required("runId", uuid)?;
    }
    if ["approve", "deny"].contains(&action.as_str()) {
        o.required("approvalId", uuid)?;
        o.required("inputHash", |v| pattern(v, r"^[a-f0-9]{64}$"))?;
    }
    if action == "run-now" {
        o.optional("entityId", uuid)?;
    }
    Ok(o.finish())
}
/// Receives a validated trigger.
pub fn trigger_label(trigger: &Value) -> String {
    let s = |key| trigger[key].as_str().unwrap_or_default();
    match s("kind") {
        "webhook" => "Authenticated webhook".into(),
        "schedule" => format!(
            "Every {} {} · {}",
            trigger["interval"],
            s("unit"),
            s("timeZone")
        ),
        _ => {
            let entity = s("entity");
            let name = entity
                .chars()
                .next()
                .map(|c| c.to_uppercase().to_string() + &entity[c.len_utf8()..])
                .unwrap_or_default();
            let property = s("property");
            format!(
                "{name} · {}{}",
                if property.is_empty() {
                    String::new()
                } else {
                    format!("{property} ")
                },
                s("event")
            )
        }
    }
}

pub const RUN_WALL_CLOCK_MS: i64 = 4 * 60_000;
pub const SETTLEMENT_GRACE_MS: i64 = 10_000;
pub const CANCEL_SETTLEMENT_MS: i64 = 30_000;
pub const RUN_LEASE_MS: i64 = 5 * 60_000;
pub const SCHEDULER_SETUP_MS: i64 = 20_000;
pub const FUNCTION_DURATION_SECONDS: i64 = 300;
pub const ARTIFACT_INTENT_LEASE_MS: i64 = 20 * 60_000;
pub fn scheduler_driver(env: &Value) -> std::result::Result<&str, &'static str> {
    let driver = env["FORGE_LOOP_SCHEDULER_DRIVER"]
        .as_str()
        .unwrap_or("vercel");
    if ["vercel", "cloudflare"].contains(&driver) {
        Ok(driver)
    } else {
        Err("FORGE_LOOP_SCHEDULER_DRIVER must be vercel or cloudflare.")
    }
}
pub fn enabled(env: &Value) -> bool {
    crate::documents::feature_enabled(env, "FORGE_LOOPS_ENABLED")
}
pub fn principal_id(loop_id: &str) -> String {
    format!("forge-loop:{loop_id}")
}
/// Use Auto's selection and audit trail with a published explicit effort, while
/// leaving the personal-conversation Auto behavior unchanged.
pub fn resolve_model(
    input: &Value,
) -> std::result::Result<Value, crate::agents::routing::RoutingError> {
    let mut scoped = input.clone();
    scoped["mode"] = json!("auto");
    scoped["availableModels"] = json!(
        input["availableModels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["locality"] == "server-capable" && m["executionKind"] == "forge-native")
            .collect::<Vec<_>>()
    );
    let selected = crate::agents::routing::resolve(&scoped)?;
    if input.get("reasoningEffort").is_none() {
        return Ok(selected);
    }
    scoped["mode"] = json!("manual");
    scoped["manualModel"] = selected["model"].clone();
    let mut explicit = crate::agents::routing::resolve(&scoped)?;
    for key in [
        "requestedSelection",
        "routingPolicyVersion",
        "routingReason",
    ] {
        explicit[key] = selected[key].clone();
    }
    Ok(explicit)
}
