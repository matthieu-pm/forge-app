//! The shared issue-list contract. Keep schema key order for source-compatible
//! cursor bindings, independently of the caller's JSON property order.
pub use crate::contract::ContractError as QueryError;
use crate::contract::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const FIELDS: &[&str] = &[
    "status",
    "assignee",
    "agent",
    "agentSession",
    "creator",
    "priority",
    "labels",
    "parentId",
    "suggestedLabel",
    "dueDate",
    "createdAt",
    "updatedAt",
    "project",
    "milestone",
    "subscribers",
    "autoClosed",
    "content",
    "description",
    "links",
    "templateName",
];
const GROUPS: &[&str] = &[
    "Status",
    "Priority",
    "Assignee",
    "Project",
    "Labels",
    "No grouping",
];
const DISPLAY: &[&str] = &[
    "layout",
    "group",
    "subgroup",
    "order",
    "descending",
    "groupDescending",
    "completedByRecency",
    "showSubIssues",
    "nested",
    "showEmpty",
    "properties",
    "showPullRequests",
];
const QUERY: &[&str] = &[
    "teamIds",
    "project",
    "milestone",
    "cycle",
    "triage",
    "showSnoozed",
    "personal",
    "scope",
    "search",
    "filters",
    "display",
    "limit",
    "cursor",
];
fn ordered(mut value: Value, keys: &[&str]) -> Value {
    let source = value.as_object_mut().expect("validated object");
    Value::Object(
        keys.iter()
            .filter_map(|key| source.remove(*key).map(|value| ((*key).into(), value)))
            .collect(),
    )
}
pub fn default_display() -> Value {
    json!({"layout":"list","group":"Status","subgroup":"No grouping","order":"Priority","descending":false,"groupDescending":false,"completedByRecency":false,"showSubIssues":true,"nested":"Show matching","showEmpty":false,"properties":["ID","Status","Assignee","Priority","Project","Due date","Labels","Created"]})
}
pub fn filters(value: Value) -> Result<Value> {
    filters_with_mode(value, false)
}
pub(crate) fn saved_filters(value: Value) -> Result<Value> {
    filters_with_mode(value, true)
}
fn filters_with_mode(value: Value, strict: bool) -> Result<Value> {
    let mut o = Object::new(value, &["match", "rules"], strict)?;
    o.required("match", |v| enumeration(v, &["all", "any"]))?;
    o.required("rules", |v| {
        list(v, 0, 20, |v| {
            let keys = &["id", "field", "operator", "value"];
            let mut o = Object::new(v, keys, strict)?;
            for (key, maximum) in [("id", 200), ("value", 500)] {
                o.required(key, |v| {
                    if strict {
                        return text(v, 0, maximum, false);
                    }
                    let v = string(v)?;
                    if v.as_str().unwrap().encode_utf16().count() > maximum {
                        return Err(ContractError("filter length"));
                    }
                    Ok(v)
                })?;
            }
            o.required("field", |v| enumeration(v, FIELDS))?;
            o.required("operator", |v| {
                enumeration(
                    v,
                    &[
                        "is",
                        "isNot",
                        "contains",
                        "notContains",
                        "set",
                        "notSet",
                        "before",
                        "after",
                    ],
                )
            })?;
            Ok(ordered(o.finish(), keys))
        })
    })?;
    Ok(ordered(o.finish(), &["match", "rules"]))
}
pub(crate) fn saved_display(value: Value) -> Result<Value> {
    display(Object::new(value, DISPLAY, true)?.finish())
}
pub fn display(value: Value) -> Result<Value> {
    let mut o = Object::new(value, DISPLAY, false)?;
    o.required("layout", |v| enumeration(v, &["list", "board"]))?;
    for key in ["group", "subgroup"] {
        o.required(key, |v| enumeration(v, GROUPS))?;
    }
    o.required("order", |v| {
        enumeration(
            v,
            &[
                "Priority", "Created", "Updated", "Due date", "Title", "Status",
            ],
        )
    })?;
    for key in [
        "descending",
        "groupDescending",
        "completedByRecency",
        "showSubIssues",
        "showEmpty",
    ] {
        o.required(key, boolean)?;
    }
    o.required("nested", |v| {
        enumeration(v, &["Show matching", "Show all", "Hide"])
    })?;
    o.required("properties", |v| list(v, 0, 30, |v| text(v, 0, 100, false)))?;
    o.optional("showPullRequests", boolean)?;
    Ok(ordered(o.finish(), DISPLAY))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "Value", into = "Value")]
pub struct IssueQuery(Value);
impl TryFrom<Value> for IssueQuery {
    type Error = QueryError;
    fn try_from(value: Value) -> Result<Self> {
        Self::parse(value)
    }
}
impl From<IssueQuery> for Value {
    fn from(value: IssueQuery) -> Self {
        value.0
    }
}
impl IssueQuery {
    pub fn parse(value: Value) -> Result<Self> {
        let mut o = Object::new(value, QUERY, true)?;
        o.optional("teamIds", |v| list(v, 0, 100, uuid))?;
        o.optional("project", |v| text(v, 0, 240, false))?;
        o.optional("milestone", |v| list(v, 0, 30, |v| text(v, 0, 240, false)))?;
        o.optional("cycle", |v| text(v, 0, 36, false))?;
        o.optional("triage", boolean)?;
        o.default("showSnoozed", json!(false), boolean)?;
        o.optional("personal", |v| {
            enumeration(v, &["assigned", "created", "subscribed", "activity"])
        })?;
        o.default("scope", json!("all"), |v| {
            enumeration(v, &["all", "active", "backlog"])
        })?;
        o.default("search", json!(""), |v| text(v, 0, 200, true))?;
        o.default("filters", json!({"match":"all","rules":[]}), filters)?;
        o.default("display", default_display(), display)?;
        o.default("limit", json!(50), |v| number(v, 1.0, 100.0, true))?;
        o.optional("cursor", |v| text(v, 0, 4096, false))?;
        Ok(Self(ordered(o.finish(), QUERY)))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
    pub fn binding(&self, actor: &crate::actor::Actor) -> String {
        use sha2::{Digest, Sha256};
        let mut parameters = self.0.clone();
        parameters.as_object_mut().unwrap().remove("cursor");
        hex::encode(Sha256::digest(json!({"parameters":parameters,"workspace":actor.workspace_id,"user":actor.user_id,"authentication":actor.authentication}).to_string().as_bytes()))
    }
}

pub fn cursor(value: Value) -> Result<Value> {
    let keys = &["version", "binding", "snapshot", "expires", "values"];
    let mut o = Object::new(value, keys, true)?;
    o.required("version", |v| number(v, 1.0, 1.0, true))?;
    o.required("binding", |v| text(v, 64, 64, false))?;
    o.required("snapshot", datetime)?;
    o.required("expires", |v| {
        number(v, -9007199254740991.0, 9007199254740991.0, true)
    })?;
    o.required("values", |v| {
        let Value::Array(values) = v else {
            return Err(ContractError("cursor values"));
        };
        if values.len() != 5 {
            return Err(ContractError("cursor values"));
        }
        values
            .into_iter()
            .enumerate()
            .map(|(i, v)| {
                if i == 4 {
                    uuid(v)
                } else {
                    text(v, 0, [40, 40, 10000, 12][i], false)
                }
            })
            .collect::<Result<Vec<_>>>()
            .map(Value::Array)
    })?;
    Ok(ordered(o.finish(), keys))
}
