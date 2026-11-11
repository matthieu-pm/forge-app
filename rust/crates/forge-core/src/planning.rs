//! Planning snapshots used by canonical issue imports and rich documents.
pub use crate::contract::ContractError as PlanningError;
use crate::contract::*;
use serde_json::{Value, json};

pub fn page(value: Value) -> Result<Value> {
    let mut o = Object::new(value, &["after", "limit", "search"], true)?;
    o.optional("after", uuid)?;
    o.default("limit", json!(50), |v| number(v, 1., 100., true))?;
    o.optional("search", |v| text(v, 0, 200, true))?;
    Ok(o.finish())
}

pub(crate) fn chart(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "title", "kind", "unit", "series", "points", "source", "caption",
        ],
        false,
    )?;
    o.required("title", |v| text(v, 1, 200, false))?;
    o.required("kind", |v| {
        enumeration(v, &["line", "bar", "funnel", "horizontalBar"])
    })?;
    o.required("unit", |v| enumeration(v, &["count", "percent"]))?;
    o.required("series", |v| list(v, 1, 3, |v| text(v, 1, 100, false)))?;
    o.required("points", |v| {
        list(v, 1, 100, |v| {
            let mut o = Object::new(v, &["label", "values"], false)?;
            o.required("label", |v| text(v, 1, 100, false))?;
            o.required("values", |v| {
                list(v, 1, 3, |v| number(v, 0.0, f64::MAX, false))
            })?;
            Ok(o.finish())
        })
    })?;
    o.required("source", |v| {
        let mut o = Object::new(
            v,
            &["provider", "account", "product", "period", "simulated"],
            false,
        )?;
        o.required("provider", |v| enumeration(v, &["PostHog", "Amplitude"]))?;
        for key in ["account", "product", "period"] {
            o.required(key, |v| text(v, 1, 100, false))?;
        }
        o.required("simulated", boolean)?;
        Ok(o.finish())
    })?;
    o.required("caption", |v| text(v, 0, 2000, false))?;
    let v = o.finish();
    let size = v["series"].as_array().unwrap().len();
    if v["points"].as_array().unwrap().iter().any(|p| {
        p["values"].as_array().unwrap().len() != size
            || (v["unit"] == "percent"
                && p["values"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n.as_f64().unwrap() > 100.0))
    }) {
        return Err(ContractError("chart values"));
    }
    Ok(v)
}
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
        if count > 10000 || depth > 64 || !node.is_object() {
            return Err(ContractError("document tree"));
        }
        let kind = node["type"].as_str().ok_or(ContractError("node type"))?;
        if ![
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
            return Err(ContractError("node type"));
        }
        if kind == "text" && !node["text"].as_str().is_some_and(|s| !s.is_empty()) {
            return Err(ContractError("text node"));
        }
        if node.get("attrs").is_some_and(|a| !a.is_object()) {
            return Err(ContractError("node attributes"));
        }
        let attrs = &node["attrs"];
        match kind {
            "analyticsChart" => {
                chart(attrs["chart"].clone())?;
            }
            "callout" => {
                icon(attrs["icon"].clone())?;
            }
            "diagram" if !attrs["source"].is_string() => return Err(ContractError("diagram")),
            "image" => {
                pattern(
                    attrs["src"].clone(),
                    r"(?i)^(https?://|data:image/(png|jpeg|gif|webp);base64,)",
                )?;
            }
            "attachment" => {
                pattern(
                    attrs["src"].clone(),
                    r"(?i)^data:[a-z0-9.+/-]*;base64,[a-z0-9+/=]*$",
                )?;
                string(attrs["name"].clone())?;
                string(attrs["mime"].clone())?;
            }
            _ => {}
        }
        if let Some(marks) = node.get("marks") {
            for mark in marks.as_array().ok_or(ContractError("marks"))? {
                if !mark.is_object()
                    || !mark["type"].as_str().is_some_and(|s| {
                        ["bold", "italic", "underline", "strike", "code", "link"].contains(&s)
                    })
                {
                    return Err(ContractError("mark"));
                }
                if mark["type"] == "link" {
                    pattern(mark["attrs"]["href"].clone(), r"(?i)^(https?://|mailto:)")?;
                }
            }
        }
        if let Some(children) = node.get("content") {
            for child in children.as_array().ok_or(ContractError("node content"))? {
                pending.push((child, depth + 1));
            }
        }
    }
    Ok(v)
}
pub fn target(v: Value) -> Result<Value> {
    let s = v.as_str().ok_or(ContractError("target date"))?;
    if s.is_empty()
        || regex::Regex::new(r"^[0-9]{4}(-(Q[1-4]|H[12]))?$|^[0-9]{4}-(0[1-9]|1[0-2])$")
            .unwrap()
            .is_match(s)
    {
        Ok(v)
    } else {
        date(v)
    }
}
fn attachment(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &["id", "name", "mime", "data", "fileId", "sizeBytes"],
        false,
    )?;
    for key in ["id", "name", "mime"] {
        o.required(key, string)?;
    }
    o.optional("data", |v| pattern(text(v, 0, 3000000, false)?, r"^data:"))?;
    o.optional("fileId", uuid)?;
    o.optional("sizeBytes", |v| number(v, 1.0, 9007199254740991.0, true))?;
    Ok(o.finish())
}
fn reaction(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["emoji", "userIds"], false)?;
    o.required("emoji", |v| text(v, 0, 20, false))?;
    o.required("userIds", |v| list(v, 0, usize::MAX, string))?;
    Ok(o.finish())
}
fn comments(v: Value, thread: bool) -> Result<Value> {
    list(v, 0, usize::MAX, |v| comment(v, thread))
}
pub(crate) fn comment(v: Value, thread: bool) -> Result<Value> {
    let keys = if thread {
        &[
            "id",
            "text",
            "authorId",
            "createdAt",
            "attachments",
            "reactions",
            "comments",
        ][..]
    } else {
        &[
            "id",
            "text",
            "authorId",
            "createdAt",
            "attachments",
            "reactions",
        ][..]
    };
    let mut o = Object::new(v, keys, false)?;
    o.required("id", string)?;
    o.required("text", |v| text(v, 1, 20000, true))?;
    o.required("authorId", string)?;
    o.required("createdAt", datetime)?;
    o.default("attachments", json!([]), |v| {
        list(v, 0, usize::MAX, attachment)
    })?;
    o.default("reactions", json!([]), |v| list(v, 0, usize::MAX, reaction))?;
    if thread {
        o.default("comments", json!([]), |v| comments(v, false))?;
    }
    Ok(o.finish())
}
pub(crate) fn update(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "text",
            "health",
            "authorId",
            "createdAt",
            "attachments",
            "reactions",
            "comments",
        ],
        false,
    )?;
    o.required("id", string)?;
    o.required("text", |v| text(v, 1, 20000, true))?;
    o.required("health", |v| {
        enumeration(v, &["On track", "At risk", "Off track"])
    })?;
    o.required("authorId", string)?;
    o.required("createdAt", datetime)?;
    o.default("attachments", json!([]), |v| {
        list(v, 0, usize::MAX, attachment)
    })?;
    o.default("reactions", json!([]), |v| list(v, 0, usize::MAX, reaction))?;
    o.default("comments", json!([]), |v| comments(v, false))?;
    Ok(o.finish())
}
pub(crate) fn resource(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "title",
            "url",
            "body",
            "icon",
            "favorite",
            "createdAt",
            "updatedAt",
        ],
        false,
    )?;
    o.required("id", string)?;
    o.required("title", |v| text(v, 1, 200, true))?;
    o.optional("url", |v| {
        let v = url(v, false)?;
        if !v.as_str().unwrap().starts_with("http:") && !v.as_str().unwrap().starts_with("https:") {
            return Err(ContractError("resource URL"));
        }
        Ok(v)
    })?;
    o.optional("body", document)?;
    o.optional("icon", icon)?;
    o.optional("favorite", boolean)?;
    o.optional("createdAt", datetime)?;
    o.optional("updatedAt", datetime)?;
    Ok(o.finish())
}
fn milestone(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "name",
            "completed",
            "targetDate",
            "description",
            "aliases",
            "descriptionHistory",
        ],
        false,
    )?;
    o.required("id", string)?;
    o.required("name", |v| text(v, 1, 200, true))?;
    o.required("completed", boolean)?;
    o.optional("targetDate", target)?;
    o.optional("description", document)?;
    o.optional("aliases", |v| list(v, 0, usize::MAX, string))?;
    o.optional("descriptionHistory", |v| {
        list(v, 0, usize::MAX, |v| {
            let mut o = Object::new(v, &["description", "createdAt"], false)?;
            o.required("description", document)?;
            o.required("createdAt", datetime)?;
            Ok(o.finish())
        })
    })?;
    Ok(o.finish())
}
pub fn project(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "revision",
            "name",
            "status",
            "statusId",
            "teamIds",
            "health",
            "summary",
            "creatorId",
            "createdAt",
            "updatedAt",
            "description",
            "icon",
            "priority",
            "leadId",
            "memberIds",
            "startDate",
            "targetDate",
            "labelIds",
            "dependencyIds",
            "slackChannelUrl",
            "updates",
            "comments",
            "resources",
            "milestones",
            "milestoneEvents",
        ],
        false,
    )?;
    o.required("id", |v| text(v, 1, usize::MAX, false))?;
    o.optional("revision", integer)?;
    o.required("name", |v| text(v, 1, 200, true))?;
    o.required("status", |v| {
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
    o.optional("statusId", |v| text(v, 0, 200, false))?;
    o.required("teamIds", |v| list(v, 0, usize::MAX, string))?;
    o.required("health", |v| {
        enumeration(v, &["On track", "At risk", "Off track", "Update missing"])
    })?;
    o.optional("summary", |v| text(v, 0, 2000, false))?;
    o.optional("creatorId", string)?;
    o.optional("createdAt", datetime)?;
    o.optional("updatedAt", datetime)?;
    o.optional("description", document)?;
    o.optional("icon", icon)?;
    o.optional("priority", |v| enumeration(v, crate::issues::PRIORITIES))?;
    o.optional("leadId", string)?;
    o.optional("memberIds", |v| list(v, 0, usize::MAX, string))?;
    o.optional("startDate", target)?;
    o.optional("targetDate", target)?;
    o.optional("labelIds", |v| list(v, 0, usize::MAX, string))?;
    o.optional("dependencyIds", |v| list(v, 0, usize::MAX, string))?;
    o.optional("slackChannelUrl", |v| {
        let v = text(v, 0, 2000, false)?;
        let s = v.as_str().unwrap();
        if !s.is_empty() {
            let u = url::Url::parse(s).map_err(|_| ContractError("Slack URL"))?;
            if u.scheme() != "https"
                || !u
                    .host_str()
                    .is_some_and(|h| h == "slack.com" || h.ends_with(".slack.com"))
            {
                return Err(ContractError("Slack URL"));
            }
        }
        Ok(v)
    })?;
    o.optional("updates", |v| list(v, 0, usize::MAX, update))?;
    o.optional("comments", |v| comments(v, true))?;
    o.optional("resources", |v| list(v, 0, usize::MAX, resource))?;
    o.optional("milestones", |v| list(v, 0, usize::MAX, milestone))?;
    o.optional("milestoneEvents", |v| {
        list(v, 0, usize::MAX, |v| {
            let mut o = Object::new(v, &["id", "text", "authorId", "createdAt"], false)?;
            for key in ["id", "text", "authorId"] {
                o.required(key, string)?;
            }
            o.required("createdAt", datetime)?;
            Ok(o.finish())
        })
    })?;
    Ok(o.finish())
}
