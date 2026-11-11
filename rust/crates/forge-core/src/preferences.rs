//! Per-field account and workspace contracts, compiled from the source schema.
//! Rust owns validation and normalization; no JavaScript runs in the application.
pub use crate::contract::ContractError as PreferenceError;
use crate::contract::*;
use serde_json::{Map, Value, json};
use std::{collections::HashSet, sync::OnceLock};
pub mod imports;
pub fn schemas() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../data/preference-schemas.json"))
            .expect("compiled preference schemas")
    })
}
pub(crate) fn kind(s: &Value) -> &str {
    s["kind"].as_str().unwrap_or_default()
}
pub(crate) fn parse(s: &Value, v: Option<&Value>, strict: bool) -> Result<Option<Value>> {
    if kind(s) == "optional" && v.is_none() {
        return Ok(None);
    }
    if kind(s) == "default" && v.is_none() {
        return Ok(Some(s["value"].clone()));
    }
    if matches!(kind(s), "optional" | "default") {
        return parse(&s["inner"], v, strict);
    }
    let v = v.ok_or(ContractError("missing preference"))?;
    let mut result = match kind(s) {
        "string" => string(v.clone())?,
        "boolean" => boolean(v.clone())?,
        "number" => number(v.clone(), f64::MIN, f64::MAX, false)?,
        "literal" => literal(v.clone(), s["values"][0].clone())?,
        "enum" => {
            if !s["values"].as_array().unwrap().contains(v) {
                return Err(ContractError("preference choice"));
            }
            v.clone()
        }
        "object" => {
            let input = v.as_object().ok_or(ContractError("preference object"))?;
            let fields = s["fields"].as_object().unwrap();
            if (strict || s["strict"] == true) && input.keys().any(|k| !fields.contains_key(k)) {
                return Err(ContractError("unknown preference field"));
            }
            let mut out = Map::new();
            for (k, s) in fields {
                if let Some(v) = parse(s, input.get(k), strict)? {
                    out.insert(k.clone(), v);
                }
            }
            Value::Object(out)
        }
        "array" => {
            let input = v.as_array().ok_or(ContractError("preference list"))?;
            Value::Array(
                input
                    .iter()
                    .map(|v| {
                        parse(&s["element"], Some(v), strict)
                            .and_then(|v| v.ok_or(ContractError("list item")))
                    })
                    .collect::<Result<_>>()?,
            )
        }
        _ => return Err(ContractError("preference schema")),
    };
    for check in s["checks"].as_array().unwrap() {
        match kind(check) {
            "trim" => result = text(result, 0, usize::MAX, true)?,
            "min" | "max" => {
                let length = if let Some(s) = result.as_str() {
                    crate::text::length(s)
                } else {
                    result
                        .as_array()
                        .ok_or(ContractError("preference length"))?
                        .len()
                };
                let limit = check["value"].as_u64().unwrap() as usize;
                if (kind(check) == "min" && length < limit)
                    || (kind(check) == "max" && length > limit)
                {
                    return Err(ContractError("preference length"));
                }
            }
            "integer" => result = number(result, -9007199254740991.0, 9007199254740991.0, true)?,
            "minimum" => {
                if result.as_f64().unwrap() < check["value"].as_f64().unwrap() {
                    return Err(ContractError("preference minimum"));
                }
            }
            "datetime" => result = datetime(result)?,
            "pattern" => {
                if !regex::Regex::new(check["value"].as_str().unwrap())
                    .expect("compiled preference pattern")
                    .is_match(result.as_str().unwrap())
                {
                    return Err(ContractError("preference pattern"));
                }
            }
            "choices" => {
                if !check["value"].as_array().unwrap().contains(&result) {
                    return Err(ContractError("preference choices"));
                }
            }
            "unique" | "uniqueIds" => {
                let mut seen = HashSet::new();
                for item in result.as_array().unwrap() {
                    let v = if kind(check) == "uniqueIds" {
                        &item["id"]
                    } else {
                        item
                    };
                    if !seen.insert(v.as_str().unwrap()) {
                        return Err(ContractError("duplicate preference"));
                    }
                }
            }
            _ => return Err(ContractError("preference check")),
        }
    }
    Ok(Some(result))
}
pub(crate) fn field_schema(scope: &str, key: &str) -> Option<&'static Value> {
    let mut parts = key.split('.');
    let mut schema = if scope == "workspace" {
        let kind = parts.next()?;
        let resource = parts.next()?;
        if resource.is_empty()
            || resource.len() > 500
            || !resource
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_%~-".contains(&c))
        {
            return None;
        }
        schemas()["workspace"].get(kind)?
    } else {
        &schemas()["account"]
    };
    let mut count = 0;
    for part in parts {
        if kind(schema) != "object" {
            return None;
        }
        schema = schema["fields"].get(part)?;
        count += 1;
    }
    if count == 0 || kind(schema) == "object" {
        None
    } else {
        Some(schema)
    }
}
pub fn field(scope: &str, key: &str, v: Value, strict: bool) -> Result<Value> {
    parse(
        field_schema(scope, key).ok_or(ContractError("preference path"))?,
        Some(&v),
        strict,
    )?
    .ok_or(ContractError("preference value"))
}
pub fn command(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "sessionId",
            "scope",
            "expectedWorkspaceId",
            "commandKey",
            "version",
            "patch",
            "expectedVersions",
        ],
        true,
    )?;
    o.required("sessionId", |v| text(v, 1, 255, false))?;
    o.optional("scope", |v| enumeration(v, &["account", "workspace"]))?;
    o.optional("expectedWorkspaceId", |v| text(v, 1, 255, false))?;
    o.required("commandKey", uuid)?;
    o.required("version", |v| literal(v, json!(1)))?;
    o.required("patch", record)?;
    o.required("expectedVersions", versions)?;
    let v = o.finish();
    let scope = v["scope"].as_str().unwrap_or("account");
    if scope == "workspace" && v.get("expectedWorkspaceId").is_none() {
        return Err(ContractError("originating workspace"));
    }
    let patch = v["patch"].as_object().unwrap();
    let expected = v["expectedVersions"].as_object().unwrap();
    if patch.is_empty() || patch.len() > 500 || patch.len() != expected.len() {
        return Err(ContractError("preference patch"));
    }
    for (k, value) in patch {
        field(scope, k, value.clone(), true)?;
        if !expected.contains_key(k) {
            return Err(ContractError("field version"));
        }
    }
    Ok(v)
}
fn literal(v: Value, wanted: Value) -> Result<Value> {
    if v == wanted || (wanted.is_number() && v.as_f64() == wanted.as_f64()) {
        Ok(wanted)
    } else {
        Err(ContractError("literal"))
    }
}
fn versions(v: Value) -> Result<Value> {
    let mut o = record(v)?;
    for v in o.as_object_mut().unwrap().values_mut() {
        *v = integer(v.take())?;
    }
    Ok(o)
}
pub fn snapshot(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "version",
            "userId",
            "workspaceId",
            "revision",
            "values",
            "fieldVersions",
        ],
        true,
    )?;
    o.required("version", |v| literal(v, json!(1)))?;
    o.required("userId", |v| text(v, 1, usize::MAX, false))?;
    o.optional("workspaceId", |v| text(v, 1, usize::MAX, false))?;
    o.required("revision", integer)?;
    o.required("values", record)?;
    o.required("fieldVersions", versions)?;
    Ok(o.finish())
}
pub fn empty(user: &str) -> Value {
    json!({"version":1,"userId":user,"revision":0,"values":{},"fieldVersions":{}})
}
/// Unknown/future values remain in storage; each supported field decodes independently.
pub fn decode(scope: &str, view: Option<(&str, &str)>, values: &Value) -> Result<Value> {
    fn walk(s: &Value, defaults: &Value, path: &str, values: &Value) -> Value {
        if kind(s) == "object" {
            let mut out = Map::new();
            for (k, child) in s["fields"].as_object().unwrap() {
                let prefix = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                let value = walk(child, &defaults[k], &prefix, values);
                if !value.is_null() {
                    out.insert(k.clone(), value);
                }
            }
            Value::Object(out)
        } else {
            parse(s, values.get(path), false)
                .ok()
                .flatten()
                .unwrap_or_else(|| defaults.clone())
        }
    }
    if scope == "account" {
        Ok(walk(
            &schemas()["account"],
            &schemas()["defaults"]["account"],
            "",
            values,
        ))
    } else {
        let (k, r) = view.ok_or(ContractError("workspace view"))?;
        let schema = schemas()["workspace"]
            .get(k)
            .ok_or(ContractError("workspace view"))?;
        Ok(walk(
            schema,
            &schemas()["defaults"]["workspace"][k],
            &format!("{k}.{}", encode_resource(r)),
            values,
        ))
    }
}
pub fn encode_resource(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_!~*'()".contains(&b) {
            out.push(b as char)
        } else {
            out.push_str(&format!("%{b:02X}"))
        }
    }
    out
}
