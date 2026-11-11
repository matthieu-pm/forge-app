use super::*;
pub const PREFIXES: &[&str] = &[
    "forge:inbox:v1:",
    "forge:team-issue-edit-drafts:v1:",
    "forge:team-relationship-draft:v1:",
    "forge:comment-draft:v1:",
    "forge:file-draft:v1:",
    "forge:issue-engagement-draft:v1:",
    "forge:pending-recovery:v1:",
    "forge:legacy-conflict:v1:",
];
pub fn issue_key(key: &str) -> bool {
    PREFIXES.iter().any(|p| key.starts_with(p))
}
fn single(key: &str) -> bool {
    [
        "forge:comment-draft:v1:",
        "forge:file-draft:v1:",
        "forge:issue-engagement-draft:v1:",
    ]
    .iter()
    .any(|p| key.starts_with(p))
}
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Read,
    Scrub,
}
fn entry_id(entry: &Value, field: &str) -> Result<Option<String>> {
    if !entry.is_object() {
        return Err(ContractError("saved issue copy"));
    }
    if field == "entries" {
        if entry.get("issue").is_some_and(truthy) {
            if !entry["issue"].is_object() {
                return Err(ContractError("saved issue copy"));
            }
            Ok(target(&entry["issue"]["id"]))
        } else {
            Ok(None)
        }
    } else {
        Ok(target(&entry["issueId"]))
    }
}
pub fn filter_issue<F: FnMut(&str) -> bool>(
    key: &str,
    value: Option<&str>,
    keep: &mut F,
    depth: usize,
    mode: Mode,
) -> Result<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    if !issue_key(key) {
        return Ok(Some(raw.into()));
    }
    bounded(depth)?;
    let mut data = object(raw)?;
    if single(key) {
        let id = target(&data["issueId"]).ok_or(ContractError("comment draft"))?;
        return Ok(keep(&id).then(|| raw.into()));
    }
    if wrapper(key) {
        let (key, value) = nested(&data)?;
        let next = filter_issue(key, value, keep, depth + 1, mode)?;
        let Some(next) = next else {
            return Ok(None);
        };
        data["value"] = Value::String(next);
        return Ok(Some(javascript_stringify(&data)));
    }
    if key.starts_with("forge:team-relationship-draft:v1:") {
        if !data["input"].is_object() {
            return Err(ContractError("relationship copy"));
        }
        let a = target(&data["input"]["issueId"]).ok_or(ContractError("relationship copy"))?;
        let b = target(&data["input"]["targetId"]).ok_or(ContractError("relationship copy"))?;
        return Ok((keep(&a) && keep(&b)).then(|| raw.into()));
    }
    let field = if key.starts_with("forge:inbox:v1:") {
        "entries"
    } else {
        "edits"
    };
    let old = data[field]
        .as_array()
        .ok_or(ContractError("saved issue copy"))?;
    let mut entries = vec![];
    for entry in old {
        let id = entry_id(entry, field)?;
        if field == "edits" && id.is_none() {
            return Err(ContractError("edit copy"));
        }
        if id.is_none_or(|id| keep(&id)) {
            entries.push(entry.clone());
        }
    }
    if field == "edits" && entries.len() != old.len() {
        if mode == Mode::Read || entries.is_empty() {
            return Ok(None);
        }
        data["requiresReview"] = Value::Bool(true);
    }
    // Replacing an existing field retains its JSON insertion position.
    data[field] = Value::Array(entries);
    Ok(Some(javascript_stringify(&data)))
}
pub fn issue_ids(key: &str, value: Option<&str>) -> Result<Vec<String>> {
    let mut ids = vec![];
    let mut seen = HashSet::new();
    filter_issue(
        key,
        value,
        &mut |id| {
            if seen.insert(id.to_owned()) {
                ids.push(id.to_owned());
            }
            true
        },
        0,
        Mode::Scrub,
    )?;
    if ids.len() > 5000 {
        return Err(ContractError(
            "Saved issue copy exceeds its supported limit.",
        ));
    }
    Ok(ids)
}
pub fn filter_project<F: FnMut(&str) -> bool>(
    key: &str,
    value: Option<&str>,
    keep: &mut F,
    depth: usize,
) -> Result<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    bounded(depth)?;
    if let Some(id) = post_project(key) {
        return Ok(keep(&id).then(|| raw.into()));
    }
    if key.starts_with(INITIATIVE_COMMAND) {
        let changes = crate::initiatives::changes(parse(raw)?)?;
        let visible = changes.as_array().unwrap().iter().all(|c| {
            crate::projects::array(c, "addProjectIds")
                .iter()
                .chain(crate::projects::array(c, "removeProjectIds"))
                .all(|id| keep(id.as_str().unwrap()))
        });
        return Ok(visible.then(|| raw.into()));
    }
    if key.starts_with(PROJECT_COMMAND) {
        let changes = crate::projects::changes(parse(raw)?)?;
        let visible = changes.as_array().unwrap().iter().all(|c| {
            (c["expectedRevision"].is_null() || keep(c["id"].as_str().unwrap()))
                && c["relocation"]["targetId"].as_str().is_none_or(&mut *keep)
        });
        return Ok(visible.then(|| raw.into()));
    }
    if wrapper(key) {
        let data = object(raw)?;
        let (key, value) = nested(&data)?;
        return Ok(filter_project(key, value, keep, depth + 1)?.map(|_| raw.into()));
    }
    Ok(Some(raw.into()))
}
pub fn project_ids(key: &str, value: Option<&str>) -> Result<Vec<String>> {
    let mut ids = vec![];
    let mut seen = HashSet::new();
    filter_project(
        key,
        value,
        &mut |id| {
            if seen.insert(id.to_owned()) {
                ids.push(id.to_owned());
            }
            true
        },
        0,
    )?;
    if ids.len() > 5000 {
        return Err(ContractError(
            "Saved project copy exceeds its supported limit.",
        ));
    }
    Ok(ids)
}
pub fn retained_command(
    key: &str,
    value: Option<&str>,
    retained: &HashSet<String>,
    depth: usize,
) -> Result<bool> {
    let Some(raw) = value.filter(|s| !s.is_empty()) else {
        return Ok(false);
    };
    if !issue_key(key) {
        return Ok(false);
    }
    bounded(depth)?;
    if key.starts_with("forge:team-issue-edit-drafts:v1:") || single(key) {
        return Ok(issue_ids(key, Some(raw))?
            .iter()
            .any(|id| retained.contains(id)));
    }
    if wrapper(key) {
        let data = object(raw)?;
        if let Ok((key, value)) = nested(&data) {
            return retained_command(key, value, retained, depth + 1);
        }
    }
    Ok(false)
}
pub fn retain_hidden(
    key: &str,
    incoming: Option<&str>,
    previous: Option<&str>,
    retained: &HashSet<String>,
    depth: usize,
) -> Result<Option<String>> {
    let Some(previous) = previous.filter(|s| !s.is_empty()) else {
        return Ok(incoming.map(str::to_owned));
    };
    if !issue_key(key) || retained.is_empty() {
        return Ok(incoming.map(str::to_owned));
    }
    bounded(depth)?;
    let old = object(previous)?;
    let next = incoming.filter(|s| !s.is_empty()).map(object).transpose()?;
    if wrapper(key) {
        let Ok((nested_key, value)) = nested(&old) else {
            return Ok(incoming.map(str::to_owned));
        };
        if next.as_ref().is_some_and(|v| v["key"] != nested_key) {
            return Err(ContractError(
                "Restore or discard the unavailable recovery copy before replacing it.",
            ));
        }
        let incoming_nested = next.as_ref().and_then(|v| v["value"].as_str());
        let result = retain_hidden(nested_key, incoming_nested, value, retained, depth + 1)?;
        if let Some(value) = result {
            let mut merged = old;
            if let Some(next) = next {
                merged
                    .as_object_mut()
                    .unwrap()
                    .extend(next.as_object().unwrap().clone());
            }
            merged["value"] = Value::String(value);
            return Ok(Some(javascript_stringify(&merged)));
        }
        return Ok(incoming.map(str::to_owned));
    }
    if key.starts_with("forge:team-relationship-draft:v1:") || single(key) {
        return Ok(
            if issue_ids(key, Some(previous))?
                .iter()
                .any(|id| retained.contains(id))
            {
                Some(previous.into())
            } else {
                incoming.map(str::to_owned)
            },
        );
    }
    let field = if key.starts_with("forge:inbox:v1:") {
        "entries"
    } else {
        "edits"
    };
    let Some(entries) = old[field].as_array() else {
        return Ok(incoming.map(str::to_owned));
    };
    let mut hidden = vec![];
    for entry in entries {
        if entry_id(entry, field)?.is_some_and(|id| retained.contains(&id)) {
            hidden.push(entry.clone());
        }
    }
    if hidden.is_empty() {
        return Ok(incoming.map(str::to_owned));
    }
    let mut visible = next
        .as_ref()
        .and_then(|v| v[field].as_array())
        .cloned()
        .unwrap_or_default();
    visible.extend(hidden);
    let mut merged = old;
    if let Some(next) = next {
        merged
            .as_object_mut()
            .unwrap()
            .extend(next.as_object().unwrap().clone());
    }
    merged[field] = Value::Array(visible);
    Ok(Some(javascript_stringify(&merged)))
}
