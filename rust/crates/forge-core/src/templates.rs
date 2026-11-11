//! Source-compatible template definitions and recurring-issue authoring data.
//! Template documents intentionally retain the source's legacy editor vocabulary.
pub use crate::contract::ContractError as TemplateError;
use crate::{canonical::javascript_stringify, contract::*, planning};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

pub fn document(v: Value) -> Result<Value> {
    if v.is_null() {
        return Ok(v);
    }
    if !v.is_object() || v["type"] != "doc" {
        return Err(ContractError("document"));
    }
    let mut pending = vec![(&v, 0)];
    let mut count = 0;
    while let Some((node, depth)) = pending.pop() {
        count += 1;
        let kind = node["type"].as_str().unwrap_or_default();
        if count > 10_000
            || depth > 64
            || !node.is_object()
            || ![
                "doc",
                "paragraph",
                "text",
                "heading",
                "bulletList",
                "orderedList",
                "listItem",
                "taskList",
                "taskItem",
                "blockquote",
                "codeBlock",
                "hardBreak",
                "horizontalRule",
                "image",
                "details",
                "detailsSummary",
                "detailsContent",
                "callout",
                "diagram",
                "attachment",
                "analyticsChart",
            ]
            .contains(&kind)
        {
            return Err(ContractError("document node"));
        }
        if kind == "text" && node["text"].as_str().is_none_or(str::is_empty) {
            return Err(ContractError("document text"));
        }
        if node.get("attrs").is_some_and(|a| !a.is_object()) {
            return Err(ContractError("document attributes"));
        }
        let attrs = &node["attrs"];
        match kind {
            "analyticsChart" => {
                planning::chart(attrs["chart"].clone())?;
            }
            "callout" => {
                icon(attrs["icon"].clone())?;
            }
            "diagram" if !attrs["source"].is_string() => return Err(ContractError("diagram")),
            "image" => {
                pattern(
                    attrs["src"].clone(),
                    r"(?i-u)^(https?://|data:image/(png|jpeg|gif|webp);base64,)",
                )?;
            }
            "attachment" => {
                pattern(
                    attrs["src"].clone(),
                    r"(?i-u)^data:[a-z0-9.+/-]*;base64,[a-z0-9+/=]*$",
                )?;
                string(attrs["name"].clone())?;
                string(attrs["mime"].clone())?;
            }
            _ => {}
        }
        if let Some(marks) = node.get("marks") {
            for mark in marks.as_array().ok_or(ContractError("marks"))? {
                enumeration(
                    mark["type"].clone(),
                    &["bold", "italic", "underline", "strike", "code", "link"],
                )?;
                if mark["type"] == "link" {
                    pattern(mark["attrs"]["href"].clone(), r"(?i-u)^(https?://|mailto:)")?;
                }
            }
        }
        if let Some(content) = node.get("content") {
            for child in content
                .as_array()
                .ok_or(ContractError("document children"))?
            {
                pending.push((child, depth + 1));
            }
        }
    }
    Ok(v)
}
pub fn properties(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "teamIds",
            "status",
            "estimate",
            "priority",
            "assignee",
            "lead",
            "members",
            "project",
            "initiatives",
            "labels",
            "dependencies",
        ],
        false,
    )?;
    o.required("teamIds", |v| list(v, 0, 100, uuid))?;
    o.required("status", |v| text(v, 0, 80, false))?;
    o.optional("estimate", |v| nullable(v, |v| text(v, 0, 30, false)))?;
    o.required("priority", |v| {
        enumeration(v, &["No priority", "Urgent", "High", "Medium", "Low"])
    })?;
    for k in ["assignee", "lead"] {
        o.required(k, |v| nullable(v, string))?;
    }
    o.required("members", |v| list(v, 0, 100, string))?;
    o.required("project", |v| nullable(v, |v| text(v, 0, 200, false)))?;
    for k in ["initiatives", "labels"] {
        o.required(k, |v| list(v, 0, 100, |v| text(v, 0, 200, false)))?;
    }
    o.required("dependencies", |v| {
        list(v, 0, 100, |v| {
            let mut o = Object::new(v, &["direction", "name"], false)?;
            o.required("direction", |v| enumeration(v, &["blockedBy", "blocking"]))?;
            o.required("name", |v| text(v, 1, 200, true))?;
            Ok(o.finish())
        })
    })?;
    Ok(o.finish())
}
fn item(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["id", "title", "content", "properties"], false)?;
    o.required("id", string)?;
    o.required("title", |v| text(v, 1, 200, true))?;
    o.required("content", document)?;
    o.required("properties", properties)?;
    Ok(o.finish())
}
pub fn payload(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "name",
            "kind",
            "icon",
            "description",
            "title",
            "summary",
            "content",
            "properties",
            "visibility",
            "milestones",
            "issues",
            "subIssues",
            "issueType",
            "fields",
        ],
        false,
    )?;
    o.required("name", |v| text(v, 1, 200, true))?;
    o.required("kind", |v| {
        enumeration(v, &["issue", "project", "document"])
    })?;
    o.required("icon", icon)?;
    for k in ["description", "summary"] {
        o.required(k, |v| text(v, 0, 2000, false))?;
    }
    o.required("title", |v| text(v, 0, 200, false))?;
    o.required("content", document)?;
    o.required("properties", properties)?;
    o.required("visibility", string)?;
    o.required("milestones", |v| {
        list(v, 0, 100, |v| {
            let mut o = Object::new(v, &["id", "title", "content"], false)?;
            o.required("id", string)?;
            o.required("title", |v| text(v, 1, 200, true))?;
            o.required("content", document)?;
            Ok(o.finish())
        })
    })?;
    for k in ["issues", "subIssues"] {
        o.required(k, |v| list(v, 0, 100, item))?;
    }
    o.required("issueType", |v| enumeration(v, &["standard", "form"]))?;
    o.required("fields", |v| {
        list(v, 0, 100, |v| {
            let mut o = Object::new(v, &["id", "label", "type", "required", "options"], false)?;
            o.required("id", string)?;
            o.required("label", |v| text(v, 1, 200, true))?;
            o.required("type", |v| {
                enumeration(
                    v,
                    &["text", "textarea", "select", "checkbox", "date", "number"],
                )
            })?;
            o.required("required", boolean)?;
            o.required("options", |v| list(v, 0, 100, |v| text(v, 0, 200, false)))?;
            Ok(o.finish())
        })
    })?;
    Ok(o.finish())
}
pub fn recurring_payload(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "icon",
            "title",
            "content",
            "properties",
            "subIssues",
            "firstDue",
            "interval",
            "unit",
        ],
        false,
    )?;
    o.required("icon", icon)?;
    o.required("title", |v| text(v, 1, 200, true))?;
    o.required("content", document)?;
    o.required("properties", properties)?;
    o.required("subIssues", |v| list(v, 0, 100, item))?;
    o.required("firstDue", date)?;
    o.required("interval", |v| number(v, 1., 100., true))?;
    o.required("unit", |v| {
        enumeration(v, &["day", "week", "month", "year"])
    })?;
    Ok(o.finish())
}
pub fn scope(v: Value, recurring: bool) -> Result<Value> {
    let mut o = Object::new(v, &["slug"], false)?;
    if recurring {
        o.required("slug", |v| text(v, 1, 100, false))?;
    } else {
        o.optional("slug", |v| text(v, 1, 100, false))?;
    }
    Ok(o.finish())
}
pub fn save(v: Value, recurring: bool) -> Result<Value> {
    let mut o = Object::new(v, &["slug", "id", "updatedAt", "payload"], false)?;
    if recurring {
        o.required("slug", |v| text(v, 1, 100, false))?;
    } else {
        o.optional("slug", |v| text(v, 1, 100, false))?;
    }
    o.optional("id", uuid)?;
    o.optional(
        "updatedAt",
        |v| if recurring { datetime(v) } else { string(v) },
    )?;
    o.required("payload", |v| {
        if recurring {
            recurring_payload(v)
        } else {
            payload(v)
        }
    })?;
    let v = o.finish();
    if crate::text::length(&javascript_stringify(&v["payload"])) > 8_000_000 {
        return Err(ContractError("template size"));
    }
    Ok(v)
}
pub fn delete(v: Value, recurring: bool) -> Result<Value> {
    let mut o = Object::new(
        v,
        if recurring {
            &["slug", "id", "updatedAt"]
        } else {
            &["slug", "id"]
        },
        false,
    )?;
    if recurring {
        o.required("slug", |v| text(v, 1, usize::MAX, false))?;
        o.required("updatedAt", datetime)?;
    } else {
        o.optional("slug", |v| text(v, 1, 100, false))?;
    }
    o.required("id", uuid)?;
    Ok(o.finish())
}
pub fn default_selection(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["slug", "audience", "templateId"], false)?;
    o.required("slug", |v| text(v, 1, 100, false))?;
    o.required("audience", |v| enumeration(v, &["members", "nonMembers"]))?;
    o.required("templateId", |v| nullable(v, uuid))?;
    Ok(o.finish())
}
pub fn empty_properties(team: Option<&str>) -> Value {
    json!({"teamIds":team.into_iter().collect::<Vec<_>>(),"status":"Backlog","priority":"No priority","assignee":null,"lead":null,"members":[],"project":null,"initiatives":[],"labels":[],"dependencies":[]})
}
pub fn empty(kind: &str, team: Option<&str>) -> Value {
    json!({"name":"","kind":kind,"icon":{"kind":"icon","value":if kind=="project"{"CubeIcon"}else{"File01Icon"},"color":"#a1a1aa"},"description":"","title":"","summary":"","content":null,"properties":empty_properties(team),"visibility":team.unwrap_or_default(),"milestones":[],"issues":[],"subIssues":[],"issueType":"standard","fields":[]})
}
pub fn empty_recurring(team: &str, timezone: &str, now: DateTime<Utc>) -> Result<Value> {
    let zone = crate::timezones::Zone::parse(timezone)?;
    let first = zone
        .local(now)?
        .date()
        .checked_add_signed(Duration::days(7))
        .ok_or(ContractError("date"))?;
    let template = empty("issue", Some(team));
    Ok(
        json!({"icon":template["icon"],"title":"","content":null,"properties":template["properties"],"subIssues":[],"firstDue":first.format("%Y-%m-%d").to_string(),"interval":1,"unit":"week"}),
    )
}
