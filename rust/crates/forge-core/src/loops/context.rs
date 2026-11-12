//! Current source snapshots and activity bindings. A captured comment is not
//! authority to expose content after that comment was edited or removed.
use crate::{canonical::javascript_stringify, comments};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ActivityError(pub &'static str);

fn string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    string(Some(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(v) => javascript_stringify(v),
    }
}
pub fn snapshot_list(v: &Value) -> Vec<String> {
    match v {
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_object() || v.is_array() {
                    v.get("id")
                        .filter(|v| !v.is_null())
                        .map_or_else(String::new, |v| string(Some(v)))
                } else {
                    string(Some(v))
                }
            })
            .filter(|s| !s.is_empty())
            .collect(),
        Value::String(s) => s
            .split(',')
            .map(crate::text::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}
pub fn normalize_snapshot(entity: &str, raw: &Value) -> Value {
    let mut r = raw["properties"].as_object().cloned().unwrap_or_default();
    if let Some(raw) = raw.as_object() {
        r.extend(raw.clone());
    }
    let value = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| r.get(*k).filter(|v| !v.is_null()))
            .unwrap_or(&Value::Null)
            .clone()
    };
    let scalar = |keys: &[&str]| {
        let v = value(keys);
        if v.is_object() || v.is_array() {
            json!(javascript_stringify(&v))
        } else {
            v
        }
    };
    let mut result = Map::new();
    let fields: &[(&str, &[&str])] = &[
        ("id", &["id"]),
        ("title", &["title", "name"]),
        ("name", &["name", "title"]),
        (
            "status",
            if entity == "issue" {
                &["status_id", "statusId", "status", "state"]
            } else {
                &["status", "statusId", "status_id"]
            },
        ),
        ("priority", &["priority"]),
        ("assignee", &["assignee_id", "assigneeId", "assignee"]),
        (
            "creator",
            &[
                "creator_id",
                "creatorId",
                "created_by_user_id",
                "createdByUserId",
                "creator",
            ],
        ),
        ("agent", &["delegate_id", "agent"]),
        ("project", &["project_id", "projectId", "project"]),
        ("cycle", &["cycle_id", "cycleId", "cycle"]),
        ("owner", &["ownerId", "owner"]),
        ("lead", &["leadId", "lead"]),
        ("targetDate", &["targetDate", "target_date"]),
        ("description", &["description", "content"]),
        ("summary", &["summary"]),
        ("health", &["health"]),
        ("startDate", &["startDate", "start_date"]),
        ("endDate", &["endDate", "end_date"]),
        ("dueDate", &["dueDate", "due_date"]),
        ("parentId", &["parent_id", "parentId"]),
        ("recurrence", &["recurrence"]),
        ("snoozed", &["snoozed"]),
        ("estimate", &["estimate"]),
        ("links", &["links"]),
        ("attachments", &["attachments"]),
        ("resources", &["resources"]),
        ("views", &["views"]),
        ("icon", &["icon"]),
        ("descriptionDocument", &["descriptionDoc"]),
        ("timezone", &["timezone"]),
        ("number", &["number"]),
    ];
    for (key, keys) in fields {
        result.insert((*key).into(), scalar(keys));
    }
    result.insert(
        "team".into(),
        if value(&["team_id", "teamId", "team"]).is_null() {
            json!(snapshot_list(&value(&["teamIds"])))
        } else {
            scalar(&["team_id", "teamId", "team"])
        },
    );
    for (key, keys) in [
        ("labels", &["labelIds", "labels"][..]),
        ("projects", &["projectIds", "projects"][..]),
        ("members", &["memberIds", "members"][..]),
        ("dependencies", &["dependencyIds"][..]),
    ] {
        result.insert(key.into(), json!(snapshot_list(&value(keys))));
    }
    result.insert("triage".into(), json!(value(&["triage"]) == true));
    result.insert(
        "milestones".into(),
        json!(javascript_stringify(&value(&["milestones"]))),
    );
    Value::Object(result)
}
struct Activity<'a> {
    entry: &'a Value,
    kind: &'static str,
    parent: Option<String>,
}
fn records(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter(|v| v.is_object() || v.is_array())
}
fn activities(raw: &Value) -> Vec<Activity<'_>> {
    let p = &raw["properties"];
    let mut result: Vec<_> = records(&p["comments"])
        .map(|entry| Activity {
            entry,
            kind: "comment",
            parent: entry["parentId"].as_str().map(str::to_owned),
        })
        .collect();
    for entry in records(&p["updates"]) {
        result.push(Activity {
            entry,
            kind: "update",
            parent: None,
        });
        for comment in records(&entry["comments"]) {
            result.push(Activity {
                entry: comment,
                kind: "comment",
                parent: Some(string(entry.get("id"))),
            });
        }
    }
    result
}
fn payload(activity: &Activity<'_>) -> Value {
    let entry = activity.entry;
    let document = comments::document(
        entry
            .get("document")
            .filter(|v| !v.is_null())
            .unwrap_or(&entry["body"])
            .clone(),
        false,
    )
    .ok();
    let text = document
        .as_ref()
        .map(comments::plain_text)
        .unwrap_or_else(|| {
            ["body", "content", "text"]
                .iter()
                .find_map(|k| entry[*k].as_str())
                .unwrap_or_default()
                .into()
        });
    let id = string(entry.get("id"));
    if activity.kind == "comment" {
        json!({"comment":{"id":id,"text":text,"parentId":activity.parent,"mentionIds":document.as_ref().map(comments::mention_ids).unwrap_or_default()}})
    } else {
        json!({"update":{"id":id,"text":text}})
    }
}
pub fn activity_context(raw: &Value, event: &Value) -> Result<Value, ActivityError> {
    let saved = event
        .get("comment")
        .filter(|v| !v.is_null())
        .or_else(|| event.get("update"));
    let Some(saved) = saved else {
        return Ok(json!({}));
    };
    let unavailable = || ActivityError("The triggering activity is no longer available.");
    let id = saved["id"].as_str().ok_or_else(unavailable)?;
    let kind = if comments::truthy(&event["comment"]) {
        "comment"
    } else {
        "update"
    };
    let all = activities(raw);
    let item = all
        .iter()
        .find(|a| a.kind == kind && a.entry["id"] == id)
        .ok_or_else(unavailable)?;
    if item.entry["deleted"] == true || comments::truthy(&item.entry["deletedAt"]) {
        return Err(unavailable());
    }
    let current = payload(item);
    if saved.get("text") != current[kind].get("text") {
        return Err(ActivityError(
            "The triggering activity changed. Run the work again against its current content.",
        ));
    }
    if kind == "comment" {
        let mentions = |v: &Value| {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect::<HashSet<_>>()
        };
        if mentions(&saved["mentionIds"]) != mentions(&current["comment"]["mentionIds"]) {
            return Err(ActivityError("The triggering activity mentions changed."));
        }
    }
    Ok(current)
}
pub fn match_events(entity: &str, event: &str, before: &Value, after: &Value) -> Vec<Value> {
    let previous = if before.is_null() {
        Value::Null
    } else {
        normalize_snapshot(entity, before)
    };
    let current = normalize_snapshot(entity, after);
    let base = json!({"entity":entity,"event":event,"before":previous,"after":current});
    let mut result = Vec::new();
    if ["created", "started", "completed"].contains(&event)
        || javascript_stringify(&previous) != javascript_stringify(&current)
    {
        result.push(base.clone());
    }
    let old: HashSet<_> = activities(before)
        .iter()
        .map(|a| string(a.entry.get("id")))
        .collect();
    for activity in activities(after) {
        let entry = activity.entry;
        if !entry["id"].is_string()
            || old.contains(&string(entry.get("id")))
            || entry["deleted"] == true
            || comments::truthy(&entry["deletedAt"])
        {
            continue;
        }
        let mut v = base.clone();
        v["event"] = json!(activity.kind);
        v.as_object_mut()
            .unwrap()
            .extend(payload(&activity).as_object().unwrap().clone());
        result.push(v);
    }
    result
}
