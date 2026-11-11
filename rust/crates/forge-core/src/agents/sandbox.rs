use crate::contract::*;
use serde_json::{Value, json};

pub fn run_code(value: Value) -> Result<Value> {
    let mut o = Object::new(value, &["language", "code", "files", "timeoutMs"], true)?;
    o.required("language", |v| {
        enumeration(v, &["javascript", "typescript", "shell"])
    })?;
    o.required("code", |v| text(v, 1, 100_000, false))?;
    o.default("files", json!([]), |v| {
        list(v, 0, 20, |v| {
            let mut f = Object::new(v, &["path", "content"], true)?;
            f.required("path", |v| {
                let v = text(v, 1, 200, false)?;
                let s = v.as_str().unwrap();
                if s.starts_with('/')
                    || s.ends_with('/')
                    || s.split('/').any(|p| p == "..")
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
                {
                    return Err(ContractError("sandbox path"));
                }
                Ok(v)
            })?;
            f.required("content", |v| text(v, 0, 500_000, false))?;
            Ok(f.finish())
        })
    })?;
    timeout(&mut o)?;
    let v = o.finish();
    if v["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["content"].as_str().unwrap().len())
        .sum::<usize>()
        > 2 * 1024 * 1024
    {
        return Err(ContractError("sandbox data size"));
    }
    Ok(v)
}
fn timeout(o: &mut Object) -> Result<()> {
    o.default("timeoutMs", json!(10000), |v| number(v, 100., 30000., true))
}
pub fn manifest_entry(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["id", "version", "maximumCalls"], false)?;
    o.required("id", |v| text(v, 1, usize::MAX, false))?;
    o.required("version", |v| text(v, 1, usize::MAX, false))?;
    o.required("maximumCalls", |v| number(v, 1., 20., true))?;
    Ok(o.finish())
}
pub fn program(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &["language", "code", "capabilityManifest", "timeoutMs"],
        false,
    )?;
    o.required("language", |v| enumeration(v, &["javascript"]))?;
    o.required("code", |v| text(v, 1, 100_000, false))?;
    o.required("capabilityManifest", |v| list(v, 1, 10, manifest_entry))?;
    timeout(&mut o)?;
    Ok(o.finish())
}
pub fn call(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &["callIndex", "capabilityId", "input", "idempotencyKey"],
        false,
    )?;
    o.required("callIndex", integer)?;
    o.required("capabilityId", |v| text(v, 1, usize::MAX, false))?;
    o.required("input", record)?;
    o.optional("idempotencyKey", |v| text(v, 1, usize::MAX, false))?;
    Ok(o.finish())
}
