//! Creation contracts and form rendering shared with the reference template service.
use crate::{canonical, contract::*, text as js};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn query(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["slug", "kind"], false)?;
    o.optional("slug", |v| text(v, 1, 100, false))?;
    o.optional("kind", |v| enumeration(v, &["issue", "project"]))?;
    Ok(o.finish())
}
pub fn apply(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "commandKey",
            "templateId",
            "revision",
            "teamId",
            "triage",
            "title",
            "answers",
        ],
        true,
    )?;
    for key in ["commandKey", "templateId"] {
        o.required(key, uuid)?;
    }
    o.required("revision", |v| pattern(v, r"^[a-f0-9]{64}$"))?;
    o.optional("teamId", uuid)?;
    o.optional("triage", boolean)?;
    o.optional("title", |v| text(v, 1, 200, true))?;
    o.default("answers", json!({}), |v| {
        let entries = v.as_object().ok_or(ContractError("answers"))?;
        for (key, value) in entries {
            if js::length(key) > 200 {
                return Err(ContractError("answer key"));
            }
            if value.is_string() {
                text(value.clone(), 0, 10000, false)?;
            } else if !value.is_boolean() && !value.as_f64().is_some_and(f64::is_finite) {
                return Err(ContractError("answer"));
            }
        }
        Ok(v)
    })?;
    Ok(o.finish())
}

/// `updated_at` is the same millisecond UTC Date representation returned by the directory.
pub fn revision(payload: &Value, updated_at: &str) -> String {
    canonical::command_input_hash(&json!({"payload":payload,"updatedAt":updated_at}))
}

pub fn form_content(template: &Value, answers: &Value) -> std::result::Result<Value, String> {
    let answers = answers.as_object().ok_or("Invalid form answers.")?;
    if template["issueType"] != "form" {
        if !answers.is_empty() {
            return Err(
                "This template has no form fields. Reload templates and review your answers."
                    .into(),
            );
        }
        return Ok(template["content"].clone());
    }
    let fields = template["fields"]
        .as_array()
        .ok_or("Invalid form fields.")?;
    let mut ids = HashSet::new();
    if fields.iter().any(|f| {
        f["id"]
            .as_str()
            .is_none_or(|id| id.is_empty() || !ids.insert(id))
    }) {
        return Err("This form has duplicate or missing field identifiers. Ask a template administrator to repair it.".into());
    }
    if answers.keys().any(|id| !ids.contains(id.as_str())) {
        return Err("The form fields changed. Reload templates and review your answers.".into());
    }
    let mut content = template["content"]["content"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for field in fields {
        let answer = answers.get(field["id"].as_str().unwrap());
        let empty = answer.is_none_or(|a| a.as_str().is_some_and(|s| js::trim(s).is_empty()));
        let label = field["label"].as_str().unwrap_or_default();
        if field["required"] == true
            && (empty || (field["type"] == "checkbox" && answer != Some(&Value::Bool(true))))
        {
            return Err(format!("Complete “{label}” before creating the issue."));
        }
        if empty {
            continue;
        }
        let answer = answer.unwrap();
        let valid = match field["type"].as_str().unwrap_or_default() {
            "checkbox" => answer.is_boolean(),
            "number" => answer.as_f64().is_some_and(f64::is_finite),
            "select" => {
                answer.is_string()
                    && field["options"]
                        .as_array()
                        .is_some_and(|o| o.contains(answer))
            }
            "date" => date(answer.clone()).is_ok(),
            _ => answer.is_string(),
        };
        if !valid {
            return Err(format!("Check the answer for “{label}”."));
        }
        let text = match answer.as_bool() {
            Some(true) => "Yes".into(),
            Some(false) => "No".into(),
            _ => js_string(answer),
        };
        content.push(
            json!({"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":label}]}),
        );
        content.push(json!({"type":"paragraph","content":[{"type":"text","text":text}]}));
    }
    Ok(json!({"type":"doc","content":content}))
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => canonical::javascript_stringify(v),
    }
}
/// Legacy documents allow unknown metadata, including a non-string `text` on
/// non-text nodes. Preserve that source result; canonical issue validation then
/// rejects a non-string description instead of silently changing its meaning.
pub fn document_text(node: &Value) -> Value {
    if node.is_null() {
        return json!("");
    }
    if truthy(&node["text"]) {
        return node["text"].clone();
    }
    if node["type"] == "hardBreak" {
        return json!("\n");
    }
    let separator = if ["doc", "bulletList", "orderedList"]
        .contains(&node["type"].as_str().unwrap_or_default())
    {
        "\n"
    } else {
        ""
    };
    json!(
        node["content"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|child| js_string(&document_text(child)))
            .collect::<Vec<_>>()
            .join(separator)
    )
}
