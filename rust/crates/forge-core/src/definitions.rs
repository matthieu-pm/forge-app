//! Validated definition documents retain the existing JSON wire format. Only
//! this boundary constructs a DefinitionValue; persistence never accepts raw
//! catalog JSON or client-supplied assignment counts as authority.
use crate::text::{length, trim};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, sync::OnceLock};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DefinitionError(pub &'static str);
type Result<T> = std::result::Result<T, DefinitionError>;
fn invalid<T>() -> Result<T> {
    Err(DefinitionError("The issue definitions are invalid."))
}
fn fields(value: Value, keys: &[&str], strict: bool) -> Result<Map<String, Value>> {
    let Value::Object(mut object) = value else {
        return invalid();
    };
    if strict && object.keys().any(|k| !keys.contains(&k.as_str())) {
        return invalid();
    }
    object.retain(|key, _| keys.contains(&key.as_str()));
    Ok(object)
}
fn string(
    object: &mut Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
    trimmed: bool,
) -> Result<String> {
    let Some(value) = object.get(key).and_then(Value::as_str) else {
        return invalid();
    };
    let value = if trimmed { trim(value) } else { value };
    if length(value) < min || length(value) > max {
        return invalid();
    }
    let value = value.to_owned();
    object.insert(key.into(), json!(value));
    Ok(value)
}
fn boolean(object: &Map<String, Value>, key: &str) -> Result<bool> {
    object
        .get(key)
        .and_then(Value::as_bool)
        .ok_or(DefinitionError("Choose a boolean setting."))
}
fn integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9007199254740991.0)
}
fn array(object: &mut Map<String, Value>, key: &str) -> Result<Vec<Value>> {
    match object.remove(key) {
        Some(Value::Array(v)) => Ok(v),
        _ => invalid(),
    }
}
fn color(object: &Map<String, Value>) -> Result<()> {
    if object
        .get("color")
        .and_then(Value::as_str)
        .is_some_and(|s| {
            s.len() == 7
                && s.starts_with('#')
                && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        })
    {
        Ok(())
    } else {
        invalid()
    }
}
fn datetime(value: &Value) -> bool {
    static ISO: OnceLock<regex::Regex> = OnceLock::new();
    value.as_str().is_some_and(|s|ISO.get_or_init(||regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]+)?)?Z$").unwrap()).is_match(s)&&chrono::DateTime::parse_from_rfc3339(s).is_ok())
}
fn nullable_datetime(value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.is_null() || datetime(v))
}
fn id(value: &str) -> bool {
    crate::text::is_uuid(value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct DefinitionValue(Value);
impl<'de> Deserialize<'de> for DefinitionValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Self::parse(Value::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
impl DefinitionValue {
    pub fn defaults() -> Self {
        Self::parse(
            serde_json::from_str(include_str!("../data/issue-definitions.json"))
                .expect("default JSON"),
        )
        .expect("validated reference defaults")
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
    pub fn statuses(&self) -> &[Value] {
        self.0["statuses"]["statuses"]
            .as_array()
            .expect("validated statuses")
    }
    pub fn labels(&self) -> &[Value] {
        self.0["labels"]["labels"]
            .as_array()
            .expect("validated labels")
    }
    pub fn can_transition(&self, from: &str, to: &str) -> bool {
        from == to
            || self.0["transitions"].get(from).is_none_or(|targets| {
                targets
                    .as_array()
                    .is_some_and(|targets| targets.iter().any(|v| v == to))
            })
    }
    pub fn parse(value: Value) -> Result<Self> {
        let mut root = fields(
            value,
            &["statuses", "labels", "workflows", "transitions"],
            true,
        )?;
        let mut directory = fields(
            root.remove("statuses")
                .ok_or(DefinitionError("Choose workflow statuses."))?,
            &["statuses", "defaultId"],
            false,
        )?;
        let default = string(&mut directory, "defaultId", 0, usize::MAX, false)?;
        let mut statuses = Vec::new();
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        let mut groups = Vec::new();
        for value in array(&mut directory, "statuses")? {
            let mut status = fields(
                value,
                &["id", "group", "name", "description", "color"],
                false,
            )?;
            let id = string(&mut status, "id", 1, usize::MAX, false)?;
            let name = string(&mut status, "name", 1, 80, true)?;
            let group = string(&mut status, "group", 1, usize::MAX, false)?;
            string(&mut status, "description", 0, 240, false)?;
            color(&status)?;
            if !ids.insert(id)
                || !names.insert(name.to_lowercase())
                || ![
                    "backlog",
                    "unstarted",
                    "started",
                    "completed",
                    "canceled",
                    "duplicate",
                ]
                .contains(&group.as_str())
            {
                return invalid();
            }
            groups.push(group);
            statuses.push(Value::Object(status));
        }
        if ids.len() > 200
            || ![
                "backlog",
                "unstarted",
                "started",
                "completed",
                "canceled",
                "duplicate",
            ]
            .iter()
            .all(|g| groups.iter().any(|s| s == g))
            || groups.iter().filter(|s| s.as_str() == "duplicate").count() != 1
            || !statuses
                .iter()
                .any(|s| s["id"] == default && s["group"] != "duplicate")
        {
            return invalid();
        }
        directory.insert("statuses".into(), json!(statuses));
        root.insert("statuses".into(), Value::Object(directory));
        let mut labels = fields(
            root.remove("labels")
                .ok_or(DefinitionError("Choose label definitions."))?,
            &[
                "version",
                "catalogRevision",
                "labels",
                "groups",
                "inheritedCount",
            ],
            false,
        )?;
        if labels.get("version").and_then(Value::as_f64) != Some(1.0)
            || !labels.get("inheritedCount").is_some_and(integer)
            || labels.get("catalogRevision").is_some_and(|v| !integer(v))
        {
            return invalid();
        }
        let mut parsed_groups = Vec::new();
        let mut group_ids = HashSet::new();
        let mut group_names = HashSet::new();
        for value in array(&mut labels, "groups")? {
            let mut group = fields(
                value,
                &[
                    "id",
                    "name",
                    "description",
                    "color",
                    "createdAt",
                    "issues",
                    "lastApplied",
                ],
                false,
            )?;
            let group_id = string(&mut group, "id", 0, usize::MAX, false)?;
            let name = string(&mut group, "name", 1, 80, true)?;
            string(&mut group, "description", 0, 500, false)?;
            color(&group)?;
            if !id(&group_id)
                || !group_ids.insert(group_id)
                || !group_names.insert(name.to_lowercase())
                || group.get("createdAt").is_some_and(|v| !datetime(v))
                || group.get("issues").is_some_and(|v| !integer(v))
                || (group.contains_key("lastApplied")
                    && !nullable_datetime(group.get("lastApplied")))
            {
                return invalid();
            }
            parsed_groups.push(Value::Object(group));
        }
        if parsed_groups.len() > 200 {
            return invalid();
        }
        let mut parsed_labels = Vec::new();
        let mut label_ids = HashSet::new();
        let mut label_names = HashSet::new();
        for value in array(&mut labels, "labels")? {
            let mut label = fields(
                value,
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
                ],
                false,
            )?;
            let label_id = string(&mut label, "id", 0, usize::MAX, false)?;
            let name = string(&mut label, "name", 1, 80, true)?;
            string(&mut label, "description", 0, 500, false)?;
            color(&label)?;
            if !id(&label_id)
                || !label_ids.insert(label_id)
                || !label_names.insert(name.to_lowercase())
                || !label.get("issues").is_some_and(integer)
                || !nullable_datetime(label.get("lastApplied"))
                || !label.get("createdAt").is_some_and(datetime)
            {
                return invalid();
            }
            match label.get("groupId") {
                Some(Value::Null) => {}
                Some(Value::String(s)) if s.is_empty() || group_ids.contains(s) => {}
                _ => return invalid(),
            }
            for key in ["favorite", "archived"] {
                if label.contains_key(key) {
                    boolean(&label, key)?;
                }
            }
            parsed_labels.push(Value::Object(label));
        }
        if parsed_labels.len() > 1000 {
            return invalid();
        }
        labels.insert("groups".into(), json!(parsed_groups));
        labels.insert("labels".into(), json!(parsed_labels));
        root.insert("labels".into(), Value::Object(labels));
        let mut workflows = fields(
            root.remove("workflows")
                .ok_or(DefinitionError("Choose workflow settings."))?,
            &[
                "pullRequests",
                "branches",
                "closeParents",
                "closeChildren",
                "closeStale",
                "staleMonths",
                "staleStatus",
                "archiveMonths",
                "issueOrder",
            ],
            false,
        )?;
        let pull_requests = workflows
            .remove("pullRequests")
            .ok_or(DefinitionError("Choose pull-request rules."))?;
        workflows.insert("pullRequests".into(), parse_rules(pull_requests, &ids)?);
        let mut branches = Vec::new();
        let mut branch_ids = HashSet::new();
        let mut branch_names = HashSet::new();
        for value in array(&mut workflows, "branches")? {
            let mut branch = fields(value, &["id", "name", "rules", "useRegex"], false)?;
            let branch_id = string(&mut branch, "id", 1, usize::MAX, false)?;
            let name = string(&mut branch, "name", 1, 200, true)?;
            if !branch.contains_key("useRegex") {
                branch.insert("useRegex".into(), json!(false));
            }
            let regex = boolean(&branch, "useRegex")?;
            if !branch_ids.insert(branch_id)
                || !branch_names.insert((name.clone(), regex))
                || !valid_branch(&name, regex)
            {
                return invalid();
            }
            let branch_rules = branch
                .remove("rules")
                .ok_or(DefinitionError("Choose branch rules."))?;
            branch.insert("rules".into(), parse_rules(branch_rules, &ids)?);
            branches.push(Value::Object(branch));
        }
        workflows.insert("branches".into(), json!(branches));
        for key in ["closeParents", "closeChildren", "closeStale"] {
            boolean(&workflows, key)?;
        }
        let stale = string(&mut workflows, "staleStatus", 1, usize::MAX, false)?;
        if !root["statuses"]["statuses"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == stale && s["group"] == "canceled")
        {
            return invalid();
        }
        for key in ["staleMonths", "archiveMonths"] {
            let value = string(&mut workflows, key, 1, usize::MAX, false)?;
            if !["1", "3", "6", "9", "12"].contains(&value.as_str())
                && !(key == "archiveMonths" && value == "never")
            {
                return invalid();
            }
        }
        let order = string(&mut workflows, "issueOrder", 1, usize::MAX, false)?;
        if !["first", "last", "none"].contains(&order.as_str()) {
            return invalid();
        }
        root.insert("workflows".into(), Value::Object(workflows));
        let Some(Value::Object(transitions)) = root.get("transitions") else {
            return invalid();
        };
        for (source, targets) in transitions {
            let Some(targets) = targets.as_array() else {
                return invalid();
            };
            let mut unique = HashSet::new();
            if !ids.contains(source) || targets.len() > 200 {
                return invalid();
            }
            for target in targets {
                let Some(target) = target.as_str() else {
                    return invalid();
                };
                if !ids.contains(target) || !unique.insert(target) {
                    return invalid();
                }
            }
        }
        Ok(Self(Value::Object(root)))
    }
}
fn parse_rules(value: Value, ids: &HashSet<String>) -> Result<Value> {
    let mut rules = fields(value, &["draft", "open", "review", "ready", "merge"], false)?;
    for key in ["draft", "open", "review", "ready", "merge"] {
        let value = string(&mut rules, key, 0, usize::MAX, false)?;
        if !value.is_empty() && !ids.contains(&value) {
            return invalid();
        }
    }
    Ok(Value::Object(rules))
}
fn valid_branch(name: &str, regex: bool) -> bool {
    if name.encode_utf16().count() > 200 {
        return false;
    }
    if regex {
        return regress::Regex::new(name).is_ok();
    }
    !name.chars().any(|c| {
        trim(&c.to_string()).is_empty() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    }) && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
}
