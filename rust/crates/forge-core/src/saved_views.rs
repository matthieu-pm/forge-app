//! Versioned view definitions and project filtering without silently dropping rules.
pub use crate::contract::ContractError as ViewError;
use crate::{contract::*, issue_query, projects};
use serde_json::{Value, json};
use std::cmp::Ordering;
const PROPERTIES: &[&str] = &[
    "ID",
    "Milestones",
    "Summary",
    "Priority",
    "Status",
    "Health",
    "Teams",
    "Initiatives",
    "Lead",
    "Members",
    "Dependencies",
    "Start date",
    "Target date",
    "Issues",
    "Created",
    "Updated",
    "Labels",
];
const GROUPS: &[&str] = &[
    "No grouping",
    "Status",
    "Priority",
    "Health",
    "Teams",
    "Initiatives",
    "Lead",
];
const ORDERINGS: &[&str] = &[
    "Manual",
    "Name",
    "Priority",
    "Status",
    "Health",
    "Target date",
    "Created",
    "Updated",
];
const FIELDS: &[&str] = &[
    "Status",
    "Priority",
    "Labels",
    "Teams",
    "Lead",
    "Members",
    "Health",
    "Target date",
    "Initiatives",
    "Title & summary",
    "Specific project",
];
pub fn default_project_display() -> Value {
    json!({"layout":"List","grouping":"No grouping","ordering":"Manual","descending":false,"closed":"All","properties":["Health","Priority","Lead","Target date","Issues","Status"],"sidebar":false,"favoriteIds":[],"subscribedIds":[],"detailSidebar":false,"sidebarTab":"Health","views":[]})
}
fn project_filters(v: Value) -> Result<Value> {
    list(v, 0, 20, |v| {
        let mut o = Object::new(v, &["field", "value"], true)?;
        o.required("field", |v| enumeration(v, FIELDS))?;
        o.required("value", |v| text(v, 0, 500, false))?;
        Ok(o.finish())
    })
}
fn project_display(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "layout",
            "grouping",
            "ordering",
            "descending",
            "closed",
            "properties",
            "sidebar",
            "favoriteIds",
            "subscribedIds",
            "detailSidebar",
            "sidebarTab",
            "views",
        ],
        true,
    )?;
    o.required("layout", |v| enumeration(v, &["List", "Board", "Timeline"]))?;
    o.required("grouping", |v| enumeration(v, GROUPS))?;
    o.required("ordering", |v| enumeration(v, ORDERINGS))?;
    o.required("closed", |v| enumeration(v, &["All", "Hide", "Only"]))?;
    for k in ["descending", "sidebar"] {
        o.required(k, boolean)?;
    }
    o.default("detailSidebar", json!(false), boolean)?;
    o.required("properties", |v| {
        list(v, 0, 30, |v| enumeration(v, PROPERTIES))
    })?;
    o.required("sidebarTab", |v| {
        enumeration(v, &["Health", "Initiatives", "Teams", "Leads"])
    })?;
    for k in ["favoriteIds", "subscribedIds", "views"] {
        o.required(k, |v| {
            list(v, 0, 0, |_| Err(ContractError("personal view state")))
        })?;
    }
    Ok(o.finish())
}
pub fn definition(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "version",
            "name",
            "description",
            "icon",
            "visibility",
            "teamId",
            "kind",
            "filters",
            "display",
        ],
        true,
    )?;
    o.required("version", |v| number(v, 1., 1., true))?;
    o.required("name", |v| text(v, 1, 80, true))?;
    o.required("description", |v| text(v, 0, 2000, false))?;
    o.required("icon", |v| {
        nullable(v, |v| {
            let mut icon: crate::teams::TeamIcon =
                serde_json::from_value(v).map_err(|_| ContractError("team icon"))?;
            icon.normalize().map_err(|_| ContractError("team icon"))?;
            serde_json::to_value(icon).map_err(|_| ContractError("team icon"))
        })
    })?;
    o.required("visibility", |v| {
        enumeration(v, &["personal", "workspace", "team"])
    })?;
    o.optional("teamId", uuid)?;
    o.required("kind", |v| enumeration(v, &["issues", "projects"]))?;
    let kind = o.finish();
    let mut o = Object::new(
        kind.clone(),
        &[
            "version",
            "name",
            "description",
            "icon",
            "visibility",
            "teamId",
            "kind",
            "filters",
            "display",
        ],
        true,
    )?;
    if kind["kind"] == "issues" {
        o.required("filters", issue_query::saved_filters)?;
        o.required("display", issue_query::saved_display)?;
    } else {
        o.required("filters", project_filters)?;
        o.required("display", project_display)?;
    }
    let v = o.finish();
    if v["visibility"] == "team" && v.get("teamId").is_none() {
        return Err(ContractError("team view"));
    }
    Ok(v)
}
pub fn mutation(v: Value) -> Result<Value> {
    let action = v["action"]
        .as_str()
        .ok_or(ContractError("view action"))?
        .to_owned();
    let keys = match action.as_str() {
        "save" => &["action", "id", "expectedRevision", "definition"][..],
        "delete" => &["action", "id", "expectedRevision"][..],
        "favorite" => &["action", "id", "favorite"][..],
        _ => return Err(ContractError("view action")),
    };
    let mut o = Object::new(v, keys, true)?;
    o.required("id", uuid)?;
    match action.as_str() {
        "save" => {
            o.required("expectedRevision", |v| nullable(v, integer))?;
            o.required("definition", definition)?;
        }
        "delete" => o.required("expectedRevision", integer)?,
        _ => o.required("favorite", boolean)?,
    }
    Ok(o.finish())
}
fn str_value<'a>(v: &'a Value, k: &str, default: &'a str) -> &'a str {
    v[k].as_str().unwrap_or(default)
}
fn values(p: &Value, field: &str) -> Vec<String> {
    let (key, default) = match field {
        "Status" => ("status", ""),
        "Priority" => ("priority", "No priority"),
        "Health" => ("health", ""),
        "Lead" => ("leadId", ""),
        "Target date" => ("targetDate", ""),
        "Specific project" => ("id", ""),
        "Teams" | "Members" | "Labels" => {
            let key = match field {
                "Teams" => "teamIds",
                "Members" => "memberIds",
                _ => "labelIds",
            };
            let mut items: Vec<String> = projects::array(p, key)
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            if field == "Teams" && items.is_empty() {
                items.push(String::new());
            }
            return items;
        }
        "Initiatives" => return vec![String::new()],
        _ => return vec![],
    };
    vec![str_value(p, key, default).into()]
}
pub fn visible_projects(catalog: &[Value], definition: &Value) -> Result<Vec<Value>> {
    let display = &definition["display"];
    let mut items: Vec<Value> = catalog
        .iter()
        .filter(|p| {
            if let Some(team) = definition["teamId"].as_str()
                && !projects::array(p, "teamIds").iter().any(|v| v == team)
            {
                return false;
            }
            let closed = p["status"] == "Completed" || p["status"] == "Canceled";
            if (display["closed"] == "Hide" && closed) || (display["closed"] == "Only" && !closed) {
                return false;
            }
            projects::array(definition, "filters").iter().all(|r| {
                let (field, value) = (str_value(r, "field", ""), str_value(r, "value", ""));
                if field == "Title & summary" {
                    format!(
                        "{} {}",
                        str_value(p, "name", ""),
                        str_value(p, "summary", "")
                    )
                    .to_lowercase()
                    .contains(&value.to_lowercase())
                } else {
                    values(p, field).iter().any(|v| v == value)
                }
            })
        })
        .cloned()
        .collect();
    let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
        .map_err(|_| ContractError("view ordering"))?;
    fn priority(p: &Value) -> i32 {
        match str_value(p, "priority", "No priority") {
            "No priority" => 5,
            "Urgent" => 1,
            "High" => 2,
            "Medium" => 3,
            "Low" => 4,
            _ => -1,
        }
    }
    fn target(p: &Value) -> f64 {
        let v = str_value(p, "targetDate", "");
        if v.is_empty() {
            f64::INFINITY
        } else {
            projects::target_day(v)
                .map(|d| d.and_hms_opt(23, 59, 59).unwrap().and_utc().timestamp() as f64)
                .unwrap_or(f64::NAN)
        }
    }
    items.sort_by(|a, b| {
        let order = match str_value(display, "ordering", "") {
            "Priority" => priority(a).cmp(&priority(b)),
            "Target date" => target(a).partial_cmp(&target(b)).unwrap_or(Ordering::Equal),
            field @ ("Name" | "Status" | "Health" | "Created" | "Updated") => {
                let key = match field {
                    "Name" => "name",
                    "Status" => "status",
                    "Health" => "health",
                    "Created" => "createdAt",
                    _ => "updatedAt",
                };
                collator.compare(str_value(a, key, ""), str_value(b, key, ""))
            }
            _ => Ordering::Equal,
        };
        if display["descending"] == true {
            order.reverse()
        } else {
            order
        }
    });
    Ok(items)
}
