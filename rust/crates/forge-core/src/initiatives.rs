//! Shared initiative contracts. Configuration and content have separate authority.
use crate::{contract::*, planning};
use serde_json::{Value, json};
pub const FIELDS: &[&str] = &[
    "name",
    "summary",
    "description",
    "icon",
    "status",
    "priority",
    "ownerId",
    "targetDate",
    "updates",
    "comments",
];
pub const STATUSES: &[&str] = &["Proposed", "Planned", "Active", "Completed", "Canceled"];
pub const SCHEDULES: &[&str] = &[
    "none", "1-week", "2-weeks", "3-weeks", "4-weeks", "5-weeks", "6-weeks", "7-weeks", "8-weeks",
];
pub fn blank(creator: &str, now: &str) -> Value {
    json!({"id":uuid::Uuid::new_v4(),"name":"","summary":"","description":null,"icon":{"kind":"icon","value":"Target01Icon","color":"#eb5757"},"status":"Active","priority":"No priority","ownerId":"","creatorId":creator,"targetDate":"","labelIds":[],"teamIds":[],"createdAt":now,"updatedAt":now,"completedAt":null,"updates":[],"projects":[],"comments":[],"resources":[],"views":[]})
}
pub fn empty() -> Value {
    json!({"version":1,"nextNumber":1,"initiatives":[],"workspaceProjects":[]})
}
fn parse_fields(value: Value, partial: bool, strict: bool, bounded: bool) -> Result<Value> {
    let mut o = Object::new(value, FIELDS, strict)?;
    // Zod 4 preserves the inner default even when partial() wraps the field.
    o.default("description", Value::Null, planning::document)?;
    for key in FIELDS {
        let parse = |v| match *key {
            "name" => text(v, 1, 200, true),
            "summary" => text(v, 0, 2000, false),
            "description" => planning::document(v),
            "icon" => icon(v),
            "status" => enumeration(v, STATUSES),
            "priority" => enumeration(v, crate::issues::PRIORITIES),
            "ownerId" => text(v, 0, if bounded { 200 } else { usize::MAX }, false),
            "targetDate" => planning::target(v),
            "updates" => list(
                v,
                0,
                if bounded { 500 } else { usize::MAX },
                planning::update,
            ),
            "comments" => list(v, 0, if bounded { 500 } else { usize::MAX }, |v| {
                planning::comment(v, false)
            }),
            _ => unreachable!(),
        };
        if partial {
            o.optional(key, parse)?;
        } else {
            o.required(key, parse)?;
        }
    }
    Ok(o.finish())
}
pub fn fields(value: Value, partial: bool, strict: bool) -> Result<Value> {
    parse_fields(value, partial, strict, true)
}
pub fn changes(value: Value) -> Result<Value> {
    list(value, 1, 100, |v| {
        let mut o = Object::new(
            v,
            &[
                "id",
                "expectedRevision",
                "changes",
                "addProjectIds",
                "removeProjectIds",
            ],
            true,
        )?;
        o.required("id", uuid)?;
        o.required("expectedRevision", |v| nullable(v, integer))?;
        o.required("changes", |v| fields(v, true, true))?;
        for key in ["addProjectIds", "removeProjectIds"] {
            o.default(key, json!([]), |v| list(v, 0, 500, uuid))?;
        }
        Ok(o.finish())
    })
}
pub fn settings(value: Value) -> Result<Value> {
    let mut o = Object::new(value, &["enabled", "schedule"], false)?;
    o.required("enabled", boolean)?;
    o.required("schedule", |v| enumeration(v, SCHEDULES))?;
    Ok(o.finish())
}
pub fn settings_command(value: Value) -> Result<Value> {
    let mut o = Object::new(value, &["commandKey", "expectedRevision", "value"], true)?;
    o.required("commandKey", uuid)?;
    o.required("expectedRevision", integer)?;
    o.required("value", |v| nullable(v, |v| text(v, 0, 20_000_000, false)))?;
    let result = o.finish();
    if let Some(raw) = result["value"].as_str() {
        settings(serde_json::from_str(raw).map_err(|_| ContractError("settings"))?)?;
    }
    Ok(result)
}
pub fn initiative(value: Value) -> Result<Value> {
    let mut value = value;
    if let Some(o) = value.as_object_mut() {
        o.entry("comments").or_insert(json!([]));
    }
    let fields = parse_fields(value.clone(), false, false, false)?;
    let mut o = Object::new(
        value,
        &[
            "revision",
            "rollup",
            "id",
            "number",
            "creatorId",
            "labelIds",
            "teamIds",
            "createdAt",
            "updatedAt",
            "completedAt",
            "projects",
            "resources",
            "views",
        ],
        false,
    )?;
    o.optional("revision", integer)?;
    o.optional("rollup", |v| {
        let mut o = Object::new(
            v,
            &[
                "projectCount",
                "completedProjects",
                "issueCount",
                "completedIssues",
                "percent",
            ],
            false,
        )?;
        for key in [
            "projectCount",
            "completedProjects",
            "issueCount",
            "completedIssues",
        ] {
            o.required(key, integer)?;
        }
        o.required("percent", |v| number(v, 0., 100., true))?;
        Ok(o.finish())
    })?;
    o.required("id", |v| text(v, 1, usize::MAX, false))?;
    o.required("number", |v| number(v, 1., 9_007_199_254_740_991., true))?;
    o.required("creatorId", string)?;
    for key in ["teamIds", "labelIds"] {
        o.required(key, |v| list(v, 0, usize::MAX, string))?;
    }
    for key in ["createdAt", "updatedAt"] {
        o.required(key, datetime)?;
    }
    o.required("completedAt", |v| nullable(v, datetime))?;
    o.default("projects", json!([]), |v| {
        list(v, 0, usize::MAX, planning::project)
    })?;
    o.default("resources", json!([]), |v| {
        list(v, 0, usize::MAX, planning::resource)
    })?;
    o.default("views", json!([]), |v| {
        list(v, 0, usize::MAX, |v| {
            let mut o = Object::new(v, &["id", "name", "status"], false)?;
            o.required("id", string)?;
            o.required("name", |v| text(v, 1, 80, true))?;
            o.optional("status", |v| {
                enumeration(
                    v,
                    &[
                        "Backlog",
                        "Planned",
                        "Active",
                        "Paused",
                        "Completed",
                        "Canceled",
                    ],
                )
            })?;
            Ok(o.finish())
        })
    })?;
    let mut result = o.finish();
    result
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    Ok(result)
}
