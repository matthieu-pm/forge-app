//! Shared project save boundaries and catalog contracts.
use crate::{contract::*, planning};
use chrono::{Datelike, NaiveDate};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const FIELDS: &[&str] = &[
    "name",
    "status",
    "teamIds",
    "dependencyIds",
    "summary",
    "description",
    "icon",
    "priority",
    "leadId",
    "memberIds",
    "startDate",
    "targetDate",
    "statusId",
    "labelIds",
    "milestones",
    "updates",
    "comments",
];
pub const GROUPS: &[&str] = &["backlog", "planned", "in-progress", "completed", "canceled"];
pub fn status_value(group: &str) -> &'static str {
    match group {
        "planned" => "Planned",
        "in-progress" => "Active",
        "completed" => "Completed",
        "canceled" => "Canceled",
        _ => "Backlog",
    }
}
pub fn fields(value: Value, partial: bool, strict: bool) -> Result<Value> {
    let mut object = Object::new(value, FIELDS, strict)?;
    for key in ["teamIds", "dependencyIds"] {
        object.optional(key, |v| list(v, 0, 100, uuid))?;
    }
    for key in ["labelIds", "memberIds"] {
        object.optional(key, |v| list(v, 0, 100, |v| text(v, 1, 200, false)))?;
    }
    object.optional("leadId", |v| text(v, 0, 200, false))?;
    for key in ["milestones", "updates", "comments"] {
        object.optional(key, |v| list(v, 0, 500, Ok))?;
    }
    let value = object.finish();
    if !partial
        && ["name", "status", "teamIds"]
            .iter()
            .any(|k| value.get(k).is_none())
    {
        return Err(ContractError("project fields"));
    }
    let mut full = json!({"id":"validation","name":"Project","status":"Backlog","teamIds":[],"health":"Update missing"});
    full.as_object_mut()
        .unwrap()
        .extend(value.as_object().unwrap().clone());
    let mut parsed = planning::project(full)?;
    parsed
        .as_object_mut()
        .unwrap()
        .retain(|key, _| value.get(key).is_some());
    Ok(parsed)
}
pub fn changes(value: Value) -> Result<Value> {
    list(value, 1, 100, |value| {
        let mut o = Object::new(
            value,
            &["id", "expectedRevision", "changes", "relocation"],
            true,
        )?;
        o.required("id", uuid)?;
        o.required("expectedRevision", |v| nullable(v, integer))?;
        o.required("changes", |v| fields(v, true, true))?;
        o.optional("relocation", |v| {
            let mut r = Object::new(
                v,
                &["milestoneId", "targetId", "targetRevision", "convertId"],
                true,
            )?;
            r.required("milestoneId", |v| text(v, 1, 200, false))?;
            r.optional("targetId", uuid)?;
            r.optional("convertId", uuid)?;
            r.optional("targetRevision", integer)?;
            Ok(r.finish())
        })?;
        Ok(o.finish())
    })
}
pub fn catalog_command(value: Value) -> Result<Value> {
    let mut o = Object::new(
        value,
        &["commandKey", "kind", "value", "expectedRevision"],
        true,
    )?;
    o.required("commandKey", uuid)?;
    o.required("kind", |v| enumeration(v, &["statuses", "labels"]))?;
    o.required("value", |v| nullable(v, |v| text(v, 0, 20_000_000, false)))?;
    o.required("expectedRevision", integer)?;
    Ok(o.finish())
}
fn status(value: Value, deleted: bool) -> Result<Value> {
    let keys = if deleted {
        &["id", "group", "name", "description", "color", "index"][..]
    } else {
        &["id", "group", "name", "description", "color"][..]
    };
    let mut o = Object::new(value, keys, false)?;
    o.required("id", |v| text(v, 1, usize::MAX, false))?;
    o.required("group", |v| enumeration(v, GROUPS))?;
    o.required("name", |v| text(v, 1, 80, true))?;
    o.required("description", |v| text(v, 0, 240, true))?;
    o.required("color", |v| pattern(v, r"(?i)^#[0-9a-f]{6}$"))?;
    if deleted {
        o.required("index", integer)?;
    }
    Ok(o.finish())
}
pub fn initial_statuses() -> Value {
    json!({"version":0,"deleted":[],"statuses":GROUPS.iter().enumerate().map(|(i,g)|json!({"id":g,"group":g,"name":(["Backlog","To do","In Progress","Completed","Canceled"][i]),"color":(["#95a2b3","#bec2c8","#f2c400","#5e6ad2","#95a2b3"][i]),"description":""})).collect::<Vec<_>>()})
}
pub fn statuses(value: Value) -> Result<Value> {
    let mut o = Object::new(value, &["version", "statuses", "deleted"], false)?;
    o.required("version", integer)?;
    o.required("statuses", |v| list(v, 0, usize::MAX, |v| status(v, false)))?;
    o.required("deleted", |v| list(v, 0, usize::MAX, |v| status(v, true)))?;
    let v = o.finish();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    if array(&v, "statuses")
        .iter()
        .chain(array(&v, "deleted"))
        .any(|s| !ids.insert(s["id"].as_str().unwrap()))
        || array(&v, "statuses")
            .iter()
            .any(|s| !names.insert(s["name"].as_str().unwrap().to_lowercase()))
        || GROUPS
            .iter()
            .any(|g| !array(&v, "statuses").iter().any(|s| s["group"] == *g))
    {
        return Err(ContractError(
            "Every workflow group needs a status, with unique names and IDs.",
        ));
    }
    Ok(v)
}
fn label(value: Value, group: bool) -> Result<Value> {
    let keys = if group {
        &[
            "id",
            "name",
            "description",
            "color",
            "createdAt",
            "issues",
            "lastApplied",
        ][..]
    } else {
        &[
            "id",
            "name",
            "description",
            "color",
            "groupId",
            "issues",
            "lastApplied",
            "createdAt",
            "favorite",
            "archived",
        ][..]
    };
    let mut o = Object::new(value, keys, false)?;
    o.required("id", string)?;
    o.required("name", |v| text(v, 1, 80, true))?;
    o.required("description", |v| text(v, 0, 500, false))?;
    o.required("color", |v| pattern(v, r"(?i)^#[0-9a-f]{6}$"))?;
    if group {
        o.optional("createdAt", datetime)?;
        o.optional("issues", integer)?;
        o.optional("lastApplied", |v| nullable(v, datetime))?;
    } else {
        o.required("groupId", |v| nullable(v, string))?;
        o.required("issues", integer)?;
        o.required("lastApplied", |v| nullable(v, datetime))?;
        o.required("createdAt", datetime)?;
        o.optional("favorite", boolean)?;
        o.optional("archived", boolean)?;
    }
    Ok(o.finish())
}
pub fn labels(value: Value, validate_links: bool) -> Result<Value> {
    let mut o = Object::new(
        value,
        &[
            "version",
            "catalogRevision",
            "labels",
            "groups",
            "inheritedCount",
        ],
        false,
    )?;
    o.required("version", |v| number(v, 1., 1., true))?;
    o.optional("catalogRevision", integer)?;
    o.required("inheritedCount", integer)?;
    o.required("labels", |v| list(v, 0, usize::MAX, |v| label(v, false)))?;
    o.required("groups", |v| list(v, 0, usize::MAX, |v| label(v, true)))?;
    let v = o.finish();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    if validate_links
        && (array(&v, "labels").len() + array(&v, "groups").len() > 1000
            || array(&v, "labels")
                .iter()
                .chain(array(&v, "groups"))
                .any(|l| {
                    !ids.insert(l["id"].as_str().unwrap())
                        || !names.insert(l["name"].as_str().unwrap().to_lowercase())
                })
            || array(&v, "labels").iter().any(|l| {
                l["groupId"].as_str().is_some_and(|g| {
                    !g.is_empty() && !array(&v, "groups").iter().any(|group| group["id"] == g)
                })
            }))
    {
        return Err(ContractError(
            "Use unique label IDs and names, and valid groups.",
        ));
    }
    Ok(v)
}
pub fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map_or(&[], Vec::as_slice)
}
pub fn unique_milestones(value: &[Value]) -> Result<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for m in value {
        if !ids.insert(m["id"].as_str().unwrap_or_default()) {
            return Err(ContractError("Duplicate milestone identity."));
        }
        let local: HashSet<_> = [&m["id"], &m["name"]]
            .into_iter()
            .chain(array(m, "aliases"))
            .map(|v| v.as_str().unwrap_or_default())
            .collect();
        if local.into_iter().any(|v| !names.insert(v)) {
            return Err(ContractError(
                "Milestone names and aliases must be unique within the project.",
            ));
        }
    }
    Ok(())
}
/// Same end-of-period comparison as the existing Date.UTC / Date.parse helper.
pub fn target_day(value: &str) -> Option<NaiveDate> {
    if value.is_empty() {
        return None;
    }
    if value.len() == 10 {
        return NaiveDate::parse_from_str(value, "%Y-%m-%d").ok();
    }
    let mut year: i32 = value.get(..4)?.parse().ok()?;
    if year < 100 {
        year += 1900;
    }
    let month: u32 = if value.len() == 4 {
        12
    } else if value.as_bytes().get(5) == Some(&b'Q') {
        value.get(6..)?.parse::<u32>().ok()? * 3
    } else if value.as_bytes().get(5) == Some(&b'H') {
        value.get(6..)?.parse::<u32>().ok()? * 6
    } else {
        value.get(5..)?.parse().ok()?
    };
    let next = NaiveDate::from_ymd_opt(
        year + i32::from(month == 12),
        if month == 12 { 1 } else { month + 1 },
        1,
    )?;
    let result = next.pred_opt()?;
    debug_assert_eq!(result.month(), month);
    Some(result)
}
pub fn reconcile(
    actor: &crate::actor::Actor,
    before: &[Value],
    submitted: &[Value],
    now: &str,
) -> Result<Vec<Value>> {
    let mut identities = HashSet::new();
    if submitted
        .iter()
        .any(|v| !identities.insert(v["id"].clone()))
    {
        return Err(ContractError("Duplicate post identity."));
    }
    let editable =
        |v: &Value| v["authorId"] == actor.user_id || actor.has_role(&["owner", "admin"]);
    if before
        .iter()
        .any(|old| !submitted.iter().any(|v| v["id"] == old["id"]) && !editable(old))
    {
        return Err(ContractError("forbidden"));
    }
    let mut result = vec![];
    for entry in submitted {
        if array(entry, "attachments").len() > 3
            || array(entry, "attachments").iter().any(|a| {
                a["data"].as_str().is_some_and(|v| !v.is_empty())
                    || !a["fileId"].as_str().is_some_and(|v| !v.is_empty())
            })
        {
            return Err(ContractError(
                "Use a private upload for project attachments.",
            ));
        }
        let mut next = entry.clone();
        if let Some(old) = before.iter().find(|v| v["id"] == entry["id"]) {
            if (entry["text"] != old["text"]
                || entry["health"] != old["health"]
                || entry["attachments"] != old["attachments"])
                && !editable(old)
            {
                return Err(ContractError("forbidden"));
            }
            let mut emoji = HashSet::new();
            if array(entry, "reactions")
                .iter()
                .any(|r| !emoji.insert(r["emoji"].clone()))
            {
                return Err(ContractError("Duplicate reaction."));
            }
            for reaction in array(old, "reactions")
                .iter()
                .chain(array(entry, "reactions"))
            {
                let others = |v: &Value| {
                    let mut users: Vec<_> = array(v, "reactions")
                        .iter()
                        .find(|r| r["emoji"] == reaction["emoji"])
                        .map(|r| array(r, "userIds"))
                        .unwrap_or_default()
                        .iter()
                        .filter(|u| **u != actor.user_id)
                        .filter_map(Value::as_str)
                        .collect();
                    users.sort();
                    users.into_iter().map(str::to_owned).collect::<Vec<_>>()
                };
                if others(old) != others(entry) {
                    return Err(ContractError("forbidden"));
                }
            }
            next["authorId"] = old["authorId"].clone();
            next["createdAt"] = old["createdAt"].clone();
            for r in next["reactions"].as_array_mut().into_iter().flatten() {
                let mut seen = HashSet::new();
                r["userIds"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|v| seen.insert(v.clone()));
            }
            if entry.get("comments").is_some() {
                next["comments"] = json!(reconcile(
                    actor,
                    array(old, "comments"),
                    array(entry, "comments"),
                    now
                )?);
            }
        } else {
            if !array(entry, "reactions").is_empty() {
                return Err(ContractError("Publish before adding reactions."));
            }
            next["authorId"] = json!(actor.user_id);
            next["createdAt"] = json!(now);
            if entry.get("comments").is_some() {
                next["comments"] = json!(reconcile(actor, &[], array(entry, "comments"), now)?);
            }
        }
        result.push(next);
    }
    // The reference server's localeCompare uses the default English/root ICU ordering.
    let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
        .map_err(|_| ContractError("post ordering"))?;
    result.sort_by(|a, b| {
        collator
            .compare(
                b["createdAt"].as_str().unwrap_or_default(),
                a["createdAt"].as_str().unwrap_or_default(),
            )
            .then_with(|| {
                collator.compare(
                    b["id"].as_str().unwrap_or_default(),
                    a["id"].as_str().unwrap_or_default(),
                )
            })
    });
    Ok(result)
}
