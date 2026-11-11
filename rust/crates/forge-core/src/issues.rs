pub use crate::contract::ContractError as IssueError;
use crate::contract::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const PRIORITIES: &[&str] = &["No priority", "Urgent", "High", "Medium", "Low"];

pub fn lifecycle(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "commandKey",
            "teamId",
            "issueId",
            "expectedRevision",
            "action",
        ],
        true,
    )?;
    for key in ["commandKey", "teamId", "issueId"] {
        o.required(key, uuid)?;
    }
    o.required("expectedRevision", integer)?;
    o.required("action", |v| {
        enumeration(v, &["delete", "restore", "archive", "unarchive"])
    })?;
    Ok(o.finish())
}
pub fn inactive_query(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["teamId", "kind", "after"], true)?;
    o.required("teamId", uuid)?;
    o.required("kind", |v| enumeration(v, &["deleted", "archived"]))?;
    o.optional("after", uuid)?;
    Ok(o.finish())
}

pub fn history_query(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["issueId", "limit", "cursor"], true)?;
    o.required("issueId", uuid)?;
    o.default("limit", json!(30), |v| number(v, 1.0, 100.0, true))?;
    o.optional("cursor", |v| text(v, 0, 4096, false))?;
    Ok(o.finish())
}
pub fn history_details(v: Value, envelope: bool) -> Result<Value> {
    let keys = if envelope {
        &["version", "origin", "changes", "actor"][..]
    } else {
        &["version", "origin", "changes"][..]
    };
    let mut o = Object::new(v, keys, true)?;
    o.required("version", |v| number(v, 1.0, 1.0, true))?;
    o.default("origin", json!("command"), |v| {
        enumeration(v, &["command", "import"])
    })?;
    o.default("changes", json!([]), |v| {
        list(v, 0, 50, |v| {
            let mut o = Object::new(v, &["field", "from", "to"], true)?;
            o.required("field", |v| text(v, 0, 100, false))?;
            o.required("from", |v| text(v, 0, 1000, false))?;
            o.required("to", |v| text(v, 0, 1000, false))?;
            Ok(o.finish())
        })
    })?;
    if envelope {
        o.required("actor", |v| {
            let mut o = Object::new(v, &["userId", "name", "kind"], true)?;
            o.required("userId", |v| text(v, 1, usize::MAX, false))?;
            o.required("name", |v| text(v, 0, 200, false))?;
            o.required("kind", |v| enumeration(v, &["session", "apiKey", "agent"]))?;
            Ok(o.finish())
        })?;
    }
    Ok(o.finish())
}
pub const RELATIONSHIP_KINDS: &[&str] = &["parent", "child", "related", "blocks", "blockedBy"];
pub fn relationship_change(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "commandKey",
            "issueId",
            "expectedRevision",
            "targetId",
            "expectedTargetRevision",
            "kind",
            "action",
        ],
        true,
    )?;
    o.required("commandKey", uuid)?;
    for key in ["issueId", "targetId"] {
        o.required(key, |v| {
            Ok(json!(uuid(v)?.as_str().unwrap().to_lowercase()))
        })?;
    }
    for key in ["expectedRevision", "expectedTargetRevision"] {
        o.required(key, integer)?;
    }
    o.required("kind", |v| enumeration(v, RELATIONSHIP_KINDS))?;
    o.required("action", |v| enumeration(v, &["add", "remove"]))?;
    let value = o.finish();
    if value["issueId"] == value["targetId"] {
        return Err(ContractError("self relationship"));
    }
    Ok(value)
}
pub fn relationship_query(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["issueId", "cursor", "limit"], true)?;
    o.required("issueId", |v| {
        Ok(json!(uuid(v)?.as_str().unwrap().to_lowercase()))
    })?;
    o.optional("cursor", |v| {
        pattern(
            v,
            r"^(parent|child|related|blocks|blockedBy):[0-9a-f-]{36}$",
        )
    })?;
    o.default("limit", json!(50), |v| number(v, 1.0, 100.0, true))?;
    Ok(o.finish())
}
pub fn relationship_search(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["issueId", "search", "after"], true)?;
    o.required("issueId", |v| {
        Ok(json!(uuid(v)?.as_str().unwrap().to_lowercase()))
    })?;
    o.default("search", json!(""), |v| text(v, 0, 200, true))?;
    o.optional("after", |v| {
        Ok(json!(uuid(v)?.as_str().unwrap().to_lowercase()))
    })?;
    Ok(o.finish())
}
pub fn normalize_emoji(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\u{fe0e}' && *c != '\u{fe0f}')
        .collect()
}
pub fn allowed_reaction(value: &str) -> bool {
    static CHOICES: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    CHOICES
        .get_or_init(|| {
            serde_json::from_str(include_str!("../data/reaction-emoji.json"))
                .expect("reference emoji choices")
        })
        .contains(value)
}
pub fn subscriber_ids(value: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for id in value
        .split(',')
        .map(crate::text::trim)
        .filter(|id| !id.is_empty())
    {
        if !ids.iter().any(|s| s == id) {
            ids.push(id.into());
        }
    }
    ids
}
pub fn engagement(v: Value) -> Result<Value> {
    let action = v["action"]
        .as_str()
        .ok_or(ContractError("engagement action"))?;
    let keys = match action {
        "subscription" => &["commandKey", "teamId", "issueId", "action", "subscribed"][..],
        "reaction" => &[
            "commandKey",
            "teamId",
            "issueId",
            "action",
            "commentId",
            "emoji",
            "present",
        ][..],
        _ => return Err(ContractError("engagement action")),
    };
    let reaction = action == "reaction";
    let mut o = Object::new(v, keys, true)?;
    for key in ["commandKey", "teamId", "issueId"] {
        o.required(key, uuid)?;
    }
    o.required("action", string)?;
    if reaction {
        o.optional("commentId", uuid)?;
        o.required("emoji", |v| {
            Ok(json!(normalize_emoji(
                text(v, 1, 32, false)?.as_str().unwrap()
            )))
        })?;
        o.required("present", boolean)?;
    } else {
        o.required("subscribed", boolean)?;
    }
    Ok(o.finish())
}

fn attachment(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "fileId",
            "contentType",
            "sizeBytes",
            "checksum",
            "width",
            "name",
            "data",
        ],
        false,
    )?;
    o.optional("id", string)?;
    o.optional("fileId", uuid)?;
    o.optional("contentType", |v| text(v, 0, 120, false))?;
    o.optional("sizeBytes", |v| number(v, 1.0, 9007199254740991.0, true))?;
    o.optional("checksum", |v| pattern(v, r"^[a-f0-9]{64}$"))?;
    o.optional("width", |v| number(v, 20.0, 100.0, false))?;
    o.required("name", |v| text(v, 0, 255, false))?;
    o.required("data", |v| {
        pattern(
            text(v, 0, 2800000, false)?,
            r"^(?:data:[a-zA-Z0-9.+/-]*;base64,[a-zA-Z0-9+/=]*|)$",
        )
    })?;
    Ok(o.finish())
}
fn attachments(v: Value) -> Result<Value> {
    list(v, 0, 5, attachment)
}
fn reaction(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["emoji", "users"], false)?;
    o.required("emoji", string)?;
    o.required("users", |v| list(v, 0, usize::MAX, string))?;
    Ok(o.finish())
}
fn reactions(v: Value) -> Result<Value> {
    list(v, 0, usize::MAX, reaction)
}
fn pull_request(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "status",
            "author",
            "statusChangedAt",
            "files",
            "additions",
            "deletions",
        ],
        false,
    )?;
    o.optional("status", |v| {
        enumeration(v, &["open", "draft", "merged", "closed"])
    })?;
    o.optional("author", |v| {
        let mut o = Object::new(v, &["name", "image"], false)?;
        o.required("name", string)?;
        o.optional("image", |v| url(v, false))?;
        Ok(o.finish())
    })?;
    o.optional("statusChangedAt", datetime)?;
    for key in ["files", "additions", "deletions"] {
        o.optional(key, integer)?;
    }
    Ok(o.finish())
}
pub fn link(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["pullRequest", "title", "url"], false)?;
    o.optional("pullRequest", pull_request)?;
    o.required("title", |v| text(v, 0, 200, false))?;
    o.required("url", |v| url(v, true))?;
    Ok(o.finish())
}
fn comment(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "parentId",
            "attachmentId",
            "attachmentName",
            "resolved",
            "author",
            "authorName",
            "body",
            "document",
            "version",
            "editedAt",
            "editedBy",
            "editedByName",
            "deletedAt",
            "deletedBy",
            "createdAt",
            "edited",
            "deleted",
            "attachments",
            "reactions",
        ],
        false,
    )?;
    o.required("id", string)?;
    for key in ["parentId", "attachmentId"] {
        o.default(key, json!(""), string)?;
    }
    o.optional("attachmentName", |v| text(v, 0, 255, false))?;
    o.default("resolved", json!(false), boolean)?;
    o.required("author", string)?;
    o.optional("authorName", |v| text(v, 0, 200, false))?;
    o.required("body", |v| text(v, 0, 10000, false))?;
    o.optional("document", record)?;
    o.optional("version", integer)?;
    o.optional("editedAt", datetime)?;
    o.optional("editedBy", string)?;
    o.optional("editedByName", |v| text(v, 0, 200, false))?;
    o.optional("deletedAt", |v| nullable(v, datetime))?;
    o.optional("deletedBy", |v| nullable(v, string))?;
    o.required("createdAt", datetime)?;
    for key in ["edited", "deleted"] {
        o.default(key, json!(false), boolean)?;
    }
    o.optional("attachments", attachments)?;
    o.default("reactions", json!([]), reactions)?;
    Ok(o.finish())
}
fn activity(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "author",
            "text",
            "createdAt",
            "automaticAssignment",
            "field",
            "link",
            "linkAction",
            "from",
            "to",
        ],
        false,
    )?;
    for key in ["id", "author", "text", "createdAt"] {
        o.required(key, string)?;
    }
    o.optional("automaticAssignment", |v| {
        let mut o = Object::new(v, &["from", "to"], false)?;
        o.required("from", |v| enumeration(v, &[""]))?;
        o.required("to", string)?;
        Ok(o.finish())
    })?;
    o.optional("field", |v| {
        enumeration(
            v,
            &[
                "status", "priority", "assignee", "labels", "project", "cycle",
            ],
        )
    })?;
    o.optional("link", link)?;
    o.optional("linkAction", |v| enumeration(v, &["linked", "unlinked"]))?;
    o.optional("from", string)?;
    o.optional("to", string)?;
    Ok(o.finish())
}
pub fn cycle(v: Value) -> Result<Value> {
    if v == "" || v.as_str().is_some_and(crate::text::is_uuid) {
        Ok(v)
    } else {
        date(v)
    }
}
pub fn draft(v: Value, creation: bool) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "title",
            "description",
            "priority",
            "dueDate",
            "assignee",
            "project",
            "labels",
            "templateName",
            "attachments",
            "estimate",
            "triage",
            "snoozed",
            "status",
            "cycle",
            "parentId",
            "links",
            "subIssues",
            "recurrence",
            "agent",
            "agentSession",
            "subscribers",
            "milestone",
            "autoClosed",
            "descriptionDoc",
            "reactions",
            "comments",
            "activity",
            "favorite",
        ],
        false,
    )?;
    o.required("title", |v| text(v, usize::from(creation), 240, creation))?;
    o.required("description", |v| text(v, 0, 10000, false))?;
    o.required("priority", |v| enumeration(v, PRIORITIES))?;
    o.required("dueDate", |v| {
        pattern(v, r"^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    })?;
    for key in ["assignee", "project", "templateName"] {
        o.optional(key, |v| text(v, 0, 200, false))?;
    }
    o.optional("labels", |v| text(v, 0, 1000, false))?;
    o.optional("attachments", attachments)?;
    o.optional("estimate", |v| nullable(v, |v| text(v, 0, 30, false)))?;
    for key in ["triage", "snoozed"] {
        o.default(key, json!(false), boolean)?;
    }
    o.required("status", |v| text(v, 1, usize::MAX, false))?;
    o.default("cycle", json!(""), |v| {
        if creation { cycle(v) } else { string(v) }
    })?;
    o.default("parentId", json!(""), string)?;
    o.default("links", json!([]), |v| {
        list(v, 0, if creation { 100 } else { usize::MAX }, link)
    })?;
    o.default("subIssues", json!([]), |v| {
        list(v, 0, if creation { 100 } else { usize::MAX }, |v| {
            text(v, 1, 240, true)
        })
    })?;
    o.default("recurrence", json!(""), |v| {
        enumeration(v, &["", "daily", "weekly", "monthly"])
    })?;
    for key in ["agent", "agentSession", "subscribers", "milestone"] {
        o.default(key, json!(""), string)?;
    }
    o.default("autoClosed", json!(false), boolean)?;
    o.default("descriptionDoc", Value::Null, |v| nullable(v, record))?;
    o.default("reactions", json!([]), reactions)?;
    o.default("comments", json!([]), |v| list(v, 0, usize::MAX, comment))?;
    o.default("activity", json!([]), |v| list(v, 0, usize::MAX, activity))?;
    o.default("favorite", json!(false), boolean)?;
    Ok(o.finish())
}
pub fn blank(status: &str) -> Value {
    draft(
        json!({"title":"","description":"","priority":"No priority","dueDate":"","status":status}),
        false,
    )
    .expect("valid blank issue")
}
pub fn team_issue(v: Value) -> Result<Value> {
    let mut value = draft(v.clone(), false)?;
    value["title"] = text(v["title"].clone(), 1, 240, true)?;
    for key in ["id", "creator", "suggestedLabel"] {
        value[key] = string(v[key].clone())?;
    }
    value["number"] = number(v["number"].clone(), 1.0, 9007199254740991.0, true)?;
    for key in ["createdAt", "updatedAt", "statusChangedAt"] {
        value[key] = datetime(v[key].clone())?;
    }
    value["completedAt"] = nullable(
        v.get("completedAt")
            .ok_or(ContractError("completedAt"))?
            .clone(),
        string,
    )?;
    value["recurrenceSpawned"] =
        boolean(v.get("recurrenceSpawned").cloned().unwrap_or(json!(false)))?;
    if let Some(revision) = v.get("revision") {
        value["revision"] = integer(revision.clone())?;
    }
    if let Some(fingerprint) = v.get("legacyFingerprint") {
        value["legacyFingerprint"] = string(fingerprint.clone())?;
    }
    if let Some(sla) = v.get("sla") {
        value["sla"] = nullable(sla.clone(), |v| {
            let mut o = Object::new(
                v,
                &[
                    "id",
                    "deadline",
                    "anchor",
                    "timezone",
                    "status",
                    "completedAt",
                ],
                false,
            )?;
            o.required("id", uuid)?;
            for key in ["deadline", "anchor", "timezone"] {
                o.required(key, string)?;
            }
            o.required("status", |v| {
                enumeration(
                    v,
                    &[
                        "low-risk",
                        "moderate-risk",
                        "high-risk",
                        "breached",
                        "achieved",
                        "failed",
                        "reconciliation",
                    ],
                )
            })?;
            o.required("completedAt", |v| nullable(v, string))?;
            Ok(o.finish())
        })?;
    }
    Ok(value)
}
pub fn cycle_import(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["startDate", "endDate"], true)?;
    o.required("startDate", date)?;
    o.required("endDate", date)?;
    Ok(o.finish())
}

#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct CreateIssue(Value);
impl<'de> Deserialize<'de> for CreateIssue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Self::parse(Value::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
impl CreateIssue {
    pub fn parse(v: Value) -> Result<Self> {
        let mut o = Object::new(
            v,
            &[
                "teamId",
                "commandKey",
                "draft",
                "assigneeId",
                "legacyId",
                "projectImport",
                "cycleImport",
            ],
            true,
        )?;
        o.required("teamId", uuid)?;
        o.required("commandKey", |v| text(v, 1, 255, false))?;
        o.required("draft", |v| draft(v, true))?;
        o.optional("assigneeId", |v| {
            nullable(v, |v| text(v, 1, usize::MAX, false))
        })?;
        o.optional("legacyId", |v| text(v, 1, 255, false))?;
        o.optional("projectImport", crate::planning::project)?;
        o.optional("cycleImport", cycle_import)?;
        let value = o.finish();
        let mut size = 0.0;
        for file in value["draft"]["attachments"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if file.get("fileId").is_some() || file["data"] == "" {
                return Err(ContractError("creation attachment"));
            }
            size += file["data"]
                .as_str()
                .unwrap()
                .split(',')
                .nth(1)
                .map_or(0, |v| v.len()) as f64
                * 0.75;
        }
        if size > 2_000_000.0 {
            return Err(ContractError("creation attachments exceed 2 MB"));
        }
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
}
pub fn legacy_source(draft_value: &Value, assignee: Option<&Value>) -> Result<Value> {
    let mut d = draft_value.clone();
    d["subIssues"] = json!([]);
    let d = draft(d, false)?;
    let assigned = assignee
        .filter(|v| !v.is_null())
        .or_else(|| d.get("assignee"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({"draft":d,"assigneeId":assigned}))
}

pub fn changes(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "title",
            "description",
            "descriptionDoc",
            "status",
            "priority",
            "assignee",
            "project",
            "labels",
            "dueDate",
            "cycle",
            "parentId",
            "links",
            "recurrence",
            "milestone",
            "snoozed",
            "subIssues",
        ],
        true,
    )?;
    o.optional("title", |v| text(v, 1, 240, true))?;
    o.optional("description", |v| text(v, 0, 10000, false))?;
    o.optional("descriptionDoc", |v| nullable(v, record))?;
    o.optional("status", |v| text(v, 1, usize::MAX, false))?;
    o.optional("priority", |v| enumeration(v, PRIORITIES))?;
    for key in ["assignee", "project"] {
        o.optional(key, |v| text(v, 0, 200, false))?;
    }
    o.optional("labels", |v| text(v, 0, 1000, false))?;
    o.optional("dueDate", |v| {
        pattern(v, r"^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    })?;
    o.optional("cycle", cycle)?;
    o.optional("parentId", |v| if v == "" { Ok(v) } else { uuid(v) })?;
    o.optional("links", |v| list(v, 0, 100, link))?;
    o.optional("recurrence", |v| {
        enumeration(v, &["", "daily", "weekly", "monthly"])
    })?;
    o.optional("milestone", string)?;
    o.optional("snoozed", boolean)?;
    o.optional("subIssues", |v| list(v, 0, 100, |v| text(v, 1, 240, true)))?;
    Ok(o.finish())
}
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct EditIssues(Value);
impl<'de> Deserialize<'de> for EditIssues {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Self::parse(Value::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
impl EditIssues {
    pub fn parse(v: Value) -> Result<Self> {
        let mut o = Object::new(v, &["commandKey", "teamId", "edits"], true)?;
        o.required("commandKey", uuid)?;
        o.required("teamId", uuid)?;
        o.required("edits", |v| {
            list(v, 1, 100, |v| {
                let mut o = Object::new(
                    v,
                    &[
                        "issueId",
                        "expectedRevision",
                        "changes",
                        "triageDecision",
                        "projectImport",
                        "cycleImport",
                    ],
                    true,
                )?;
                o.required("issueId", uuid)?;
                o.required("expectedRevision", integer)?;
                o.required("changes", changes)?;
                o.optional("triageDecision", |v| enumeration(v, &["accept", "decline"]))?;
                o.optional("projectImport", crate::planning::project)?;
                o.optional("cycleImport", cycle_import)?;
                Ok(o.finish())
            })
        })?;
        let value = o.finish();
        let mut ids = std::collections::HashSet::new();
        if value["edits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| !ids.insert(e["issueId"].as_str().unwrap()))
        {
            return Err(ContractError("duplicate issue edit"));
        }
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
}
