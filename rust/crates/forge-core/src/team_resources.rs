//! Shared resource board contracts. Links are browser navigation, never server fetches.
pub use crate::contract::ContractError as ResourceError;
use crate::contract::*;
use serde_json::{Value, json};
use std::collections::HashSet;
pub fn url(raw: &str) -> Option<String> {
    if raw.chars().any(|c| (c as u32) < 32 || c == '\u{7f}') {
        return None;
    }
    let parsed = url::Url::parse(crate::text::trim(raw)).ok()?;
    if !["http", "https"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some_and(|p| !p.is_empty())
    {
        return None;
    }
    Some(parsed.to_string())
}
fn section(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["id", "name"], true)?;
    o.required("id", uuid)?;
    o.required("name", |v| text(v, 1, 80, true))?;
    Ok(o.finish())
}
fn link(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["id", "title", "url", "sectionId"], true)?;
    o.required("id", uuid)?;
    o.required("title", |v| text(v, 1, 200, true))?;
    o.required("url", |v| {
        let v = text(v, 0, 4000, false)?;
        url(v.as_str().unwrap())
            .map(Value::String)
            .ok_or(ContractError("resource URL"))
    })?;
    o.required("sectionId", |v| nullable(v, uuid))?;
    Ok(o.finish())
}
pub fn fields(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["sections", "links", "order"], true)?;
    o.required("sections", |v| list(v, 0, 100, section))?;
    o.required("links", |v| list(v, 0, 500, link))?;
    o.required("order", |v| {
        list(v, 0, 2000, |v| {
            pattern(v, r"(?i)^(document|link):[0-9a-f-]{36}$")
        })
    })?;
    let v = o.finish();
    for k in ["sections", "links", "order"] {
        let mut ids = HashSet::new();
        for item in v[k].as_array().unwrap() {
            let id = if k == "order" { item } else { &item["id"] };
            if !ids.insert(id.as_str().unwrap()) {
                return Err(ContractError("duplicate resource identity"));
            }
        }
    }
    if v["links"].as_array().unwrap().iter().any(|l| {
        !l["sectionId"].is_null()
            && !v["sections"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["id"] == l["sectionId"])
    }) {
        return Err(ContractError("resource section"));
    }
    Ok(v)
}
pub fn command(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["teamId", "expectedRevision", "fields"], true)?;
    o.required("teamId", uuid)?;
    o.required("expectedRevision", integer)?;
    o.required("fields", fields)?;
    Ok(o.finish())
}
pub fn empty() -> Value {
    json!({"revision":0,"sections":[],"links":[],"order":[]})
}
