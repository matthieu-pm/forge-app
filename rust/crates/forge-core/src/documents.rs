//! Closed rich-document vocabulary, canonical commands and lossless legacy recovery.
pub use crate::contract::ContractError as DocumentError;
use crate::{
    canonical::{command_input, javascript_stringify},
    comments::{safe_link, truthy},
    contract::*,
    planning,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
pub fn default_icon() -> Value {
    json!({"kind":"icon","value":"File01Icon","color":"#94949e"})
}
pub fn empty_body() -> Value {
    json!({"type":"doc","content":[{"type":"paragraph"}]})
}
pub fn document_icon(v: Value) -> Result<Value> {
    icon(Object::new(v, &["kind", "value", "color"], true)?.finish())
}
fn attributes(v: Value, kind: &str) -> Result<Value> {
    let keys = match kind {
        "heading" => &["level"][..],
        "orderedList" => &["start", "type"][..],
        "taskItem" => &["checked"][..],
        "codeBlock" => &["language"][..],
        "details" => &["open"][..],
        "callout" => &["icon"][..],
        "diagram" => &["source"][..],
        "analyticsChart" => &["chart"][..],
        "image" => &["src", "alt", "title", "width", "height"][..],
        _ => &[],
    };
    let mut o = Object::new(v, keys, true)?;
    match kind {
        "heading" => o.required("level", |v| number(v, 1., 3., true))?,
        "orderedList" => {
            o.optional("start", |v| number(v, 1., 10000., true))?;
            o.optional("type", |v| {
                if v.is_null() {
                    Ok(v)
                } else {
                    Err(ContractError("list type"))
                }
            })?;
        }
        "taskItem" => o.required("checked", boolean)?,
        "codeBlock" => o.optional("language", |v| nullable(v, |v| text(v, 0, 100, false)))?,
        "details" => o.optional("open", boolean)?,
        "callout" => o.required("icon", document_icon)?,
        "diagram" => o.required("source", |v| text(v, 0, 50000, false))?,
        "analyticsChart" => o.required("chart", planning::chart)?,
        "image" => {
            o.required("src", |v| {
                let v = text(v, 0, 800000, false)?;
                let s = v.as_str().unwrap();
                if pattern(
                    v.clone(),
                    r"(?i)^data:image/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$",
                )
                .is_ok()
                    || (safe_link(&v) && (s.starts_with("http:") || s.starts_with("https:")))
                {
                    Ok(v)
                } else {
                    Err(ContractError("image source"))
                }
            })?;
            for k in ["alt", "title"] {
                o.optional(k, |v| nullable(v, |v| text(v, 0, 1000, false)))?;
            }
            for k in ["width", "height"] {
                o.optional(k, |v| {
                    nullable(v, |v| {
                        let v = number(v, 0., 10000., false)?;
                        if v.as_f64().unwrap() > 0. {
                            Ok(v)
                        } else {
                            Err(ContractError("image size"))
                        }
                    })
                })?;
            }
        }
        _ => {}
    }
    Ok(o.finish())
}
fn mark(v: Value) -> Result<Value> {
    let v = Object::new(v, &["type", "attrs"], true)?.finish();
    if v["type"] == "link" {
        let mut o = Object::new(
            v["attrs"].clone(),
            &["href", "target", "rel", "class"],
            true,
        )?;
        o.required("href", |v| {
            if safe_link(&v) {
                Ok(v)
            } else {
                Err(ContractError("link"))
            }
        })?;
        for k in ["target", "rel", "class"] {
            o.optional(k, |v| nullable(v, string))?;
        }
        let attrs = o.finish();
        Ok(
            json!({"type":"link","attrs":{"href":attrs["href"],"target":"_blank","rel":"noopener noreferrer"}}),
        )
    } else {
        enumeration(
            v["type"].clone(),
            &["bold", "italic", "underline", "strike", "code"],
        )?;
        if v.get("attrs").is_some_and(truthy) {
            return Err(ContractError("formatting"));
        }
        Ok(json!({"type":v["type"]}))
    }
}
pub fn body(value: Value) -> Result<Value> {
    // Reject overdeep arbitrary JSON before the ECMAScript-compatible serializer
    // recurses. Valid document trees (64 nodes deep) stay well below this bound.
    let mut pending = vec![(&value, 0)];
    while let Some((v, depth)) = pending.pop() {
        if depth > 150 {
            return Err(ContractError("document depth"));
        }
        match v {
            Value::Array(a) => pending.extend(a.iter().map(|v| (v, depth + 1))),
            Value::Object(o) => pending.extend(o.values().map(|v| (v, depth + 1))),
            _ => {}
        }
    }
    if javascript_stringify(&value).encode_utf16().count() > 1_000_000 {
        return Err(ContractError("document size"));
    }
    fn visit(v: Value, depth: usize, parent: &str, count: &mut usize) -> Result<Value> {
        *count += 1;
        if *count > 10000 || depth > 64 {
            return Err(ContractError("document structure"));
        }
        let v = Object::new(v, &["type", "attrs", "text", "marks", "content"], true)?.finish();
        let kind = v["type"].as_str().ok_or(ContractError("node type"))?;
        let allowed = match parent {
            "root" => kind == "doc",
            "paragraph" | "heading" | "detailsSummary" => ["text", "hardBreak"].contains(&kind),
            "codeBlock" => kind == "text",
            "bulletList" | "orderedList" => kind == "listItem",
            "taskList" => kind == "taskItem",
            "details" => ["detailsSummary", "detailsContent"].contains(&kind),
            _ => [
                "paragraph",
                "heading",
                "bulletList",
                "orderedList",
                "taskList",
                "blockquote",
                "codeBlock",
                "horizontalRule",
                "image",
                "details",
                "callout",
                "diagram",
                "analyticsChart",
            ]
            .contains(&kind),
        };
        if !allowed {
            return Err(ContractError("document node"));
        }
        let mut result = json!({"type":kind});
        if kind == "text" {
            result["text"] = text(v["text"].clone(), 1, usize::MAX, false)?;
            if v.get("attrs").is_some() || v.get("content").is_some() {
                return Err(ContractError("text node"));
            }
        } else if v.get("text").is_some() || v.get("marks").is_some() {
            return Err(ContractError("formatting"));
        }
        if let Some(attrs) = v.get("attrs") {
            result["attrs"] = attributes(attrs.clone(), kind)?;
        }
        if let Some(marks) = v.get("marks") {
            result["marks"] = list(marks.clone(), 0, 6, mark)?;
        }
        if let Some(content) = v.get("content") {
            if [
                "text",
                "hardBreak",
                "horizontalRule",
                "image",
                "diagram",
                "analyticsChart",
            ]
            .contains(&kind)
            {
                return Err(ContractError("document children"));
            }
            let children = content
                .as_array()
                .ok_or(ContractError("document children"))?;
            result["content"] = Value::Array(
                children
                    .iter()
                    .map(|c| visit(c.clone(), depth + 1, kind, count))
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        if kind == "details"
            && (result["content"].as_array().map(Vec::len) != Some(2)
                || result["content"][0]["type"] != "detailsSummary"
                || result["content"][1]["type"] != "detailsContent")
        {
            return Err(ContractError("collapsible section"));
        }
        Ok(result)
    }
    visit(value, 0, "root", &mut 0)
}
pub fn fields(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["title", "body", "icon", "sectionId"], true)?;
    o.required("title", |v| text(v, 1, 200, true))?;
    o.required("body", body)?;
    o.required("icon", document_icon)?;
    o.default("sectionId", Value::Null, |v| {
        nullable(v, |v| text(v, 0, 200, false))
    })?;
    Ok(o.finish())
}
pub fn source(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["kind", "id"], true)?;
    o.required("kind", |v| {
        enumeration(v, &["workspace", "team", "project", "issue"])
    })?;
    o.optional("id", uuid)?;
    let v = o.finish();
    if (v["kind"] == "workspace") != v.get("id").is_none() {
        return Err(ContractError("document source"));
    }
    Ok(v)
}
pub fn command(v: Value) -> Result<Value> {
    let action = v["action"]
        .as_str()
        .ok_or(ContractError("action"))?
        .to_owned();
    let keys = match action.as_str() {
        "create" => &["action", "legacyImport", "id", "source", "fields"][..],
        "save" => &["action", "id", "expectedRevision", "fields"][..],
        "restore" => &["action", "id", "expectedRevision", "revision"][..],
        "delete" => &["action", "id", "expectedRevision"][..],
        "share" => &["action", "id", "expectedRevision", "shared"][..],
        _ => return Err(ContractError("action")),
    };
    let mut o = Object::new(v, keys, true)?;
    o.required("id", uuid)?;
    if action == "create" {
        o.optional("legacyImport", |v| {
            if v == true {
                Ok(v)
            } else {
                Err(ContractError("legacy import"))
            }
        })?;
        o.required("source", source)?;
    } else {
        o.required("expectedRevision", integer)?;
    }
    if ["create", "save"].contains(&action.as_str()) {
        o.required("fields", fields)?;
    }
    if action == "restore" {
        o.required("revision", |v| number(v, 1., 9_007_199_254_740_991., true))?;
    }
    if action == "share" {
        o.required("shared", boolean)?;
    }
    Ok(o.finish())
}
pub fn plain_text(v: &Value) -> String {
    let kind = v["type"].as_str().unwrap_or_default();
    if kind == "analyticsChart" {
        let Ok(chart) = planning::chart(v["attrs"]["chart"].clone()) else {
            return "[Chart unavailable]".into();
        };
        let source = &chart["source"];
        let mut lines = vec![
            chart["title"].as_str().unwrap().to_owned(),
            format!(
                "{} · {} / {} · {}{}",
                source["provider"].as_str().unwrap(),
                source["account"].as_str().unwrap(),
                source["product"].as_str().unwrap(),
                source["period"].as_str().unwrap(),
                if source["simulated"] == true {
                    " · Simulated data"
                } else {
                    ""
                }
            ),
            chart["caption"].as_str().unwrap().into(),
        ];
        for point in chart["points"].as_array().unwrap() {
            let values = point["values"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    format!(
                        "{} {}{}",
                        chart["series"][i].as_str().unwrap(),
                        javascript_stringify(n),
                        if chart["unit"] == "percent" { "%" } else { "" }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("{}: {values}", point["label"].as_str().unwrap()));
        }
        return lines.join("\n");
    }
    if kind == "text" {
        return v["text"].as_str().unwrap_or_default().into();
    }
    if kind == "hardBreak" {
        return "\n".into();
    }
    crate::projects::array(v, "content")
        .iter()
        .map(plain_text)
        .collect::<Vec<_>>()
        .join(
            if [
                "doc",
                "bulletList",
                "orderedList",
                "taskList",
                "listItem",
                "taskItem",
            ]
            .contains(&kind)
            {
                "\n"
            } else {
                ""
            },
        )
}
/// Explicit flags override development defaults; hosted environments never inherit local shortcuts.
pub fn feature_enabled(env: &Value, key: &str) -> bool {
    if let Some(value) = env.get(key) {
        return value == "true";
    }
    env["NODE_ENV"] != "production"
        && !env.get("VERCEL_ENV").is_some_and(truthy)
        && ["FORGE_ENVIRONMENT", "FORGE_SERVICE_ENVIRONMENT"]
            .iter()
            .all(|k| env.get(*k).is_none_or(|v| v == "development"))
}
pub fn matches_legacy(resource: &Value, reviewed: &Value, kind: &str) -> bool {
    if !resource.is_object()
        || if kind == "team" {
            resource["kind"] != "document"
        } else {
            resource.get("url").is_some_and(truthy)
        }
    {
        return false;
    }
    let body=resource.get("body").filter(|v|!v.is_null()).cloned().or_else(||{
        if kind=="team"{resource["content"].as_str().map(|s|json!({"type":"doc","content":s.split('\n').map(|s|if s.is_empty(){json!({"type":"paragraph"})}else{json!({"type":"paragraph","content":[{"type":"text","text":s}]})}).collect::<Vec<_>>()}))}else{Some(empty_body())}
    });
    let Some(body) = body else {
        return false;
    };
    let result = fields(
        json!({"title":resource["title"],"body":body,"icon":resource.get("icon").filter(|v|!v.is_null()).cloned().unwrap_or_else(default_icon),"sectionId":resource["sectionId"]}),
    );
    let Ok(value) = result else {
        return false;
    };
    if kind == "team"
        && resource["content"]
            .as_str()
            .is_some_and(|s| s != plain_text(&value["body"]))
    {
        return false;
    }
    command_input(&value) == command_input(reviewed)
}
pub fn retain_copies(
    value: Option<&str>,
    previous: Option<&str>,
    ids: &HashSet<String>,
) -> Result<Option<String>> {
    fn state(s: &str) -> Result<Value> {
        let v: Value = crate::json::parse(s).map_err(|_| ContractError("resource snapshot"))?;
        if !v.is_object()
            || !v["resources"].is_array()
            || v.get("retainedDocumentDrafts")
                .is_some_and(|v| !v.is_array())
        {
            return Err(ContractError("resource snapshot"));
        }
        Ok(v)
    }
    let next = value.map(state).transpose()?;
    let before = previous.map(state).transpose()?;
    let is_copy =
        |v: &&Value| v["kind"] == "document" && v["id"].as_str().is_some_and(|id| ids.contains(id));
    let mut retained = vec![];
    let mut positions = HashMap::new();
    let mut retain = |copy: &Value| {
        let key = command_input(copy);
        if let Some(index) = positions.get(&key) {
            retained[*index] = copy.clone();
        } else {
            positions.insert(key, retained.len());
            retained.push(copy.clone());
        }
    };
    for s in [&before, &next].into_iter().flatten() {
        for copy in crate::projects::array(s, "retainedDocumentDrafts") {
            retain(copy);
        }
    }
    for s in [&before, &next].into_iter().flatten() {
        for copy in crate::projects::array(s, "resources")
            .iter()
            .filter(is_copy)
        {
            retain(copy);
        }
    }
    let resources: Vec<_> = next
        .as_ref()
        .map(|v| crate::projects::array(v, "resources"))
        .unwrap_or_default()
        .iter()
        .filter(|v| !is_copy(v))
        .cloned()
        .collect();
    if retained.is_empty()
        && resources.len()
            == next
                .as_ref()
                .map_or(0, |v| crate::projects::array(v, "resources").len())
    {
        return Ok(value.map(str::to_owned));
    }
    let mut output = next.unwrap_or(json!({"favorite":false,"sections":[],"loops":[]}));
    output["resources"] = json!(resources);
    output["retainedDocumentDrafts"] = json!(retained);
    Ok(Some(javascript_stringify(&output)))
}
