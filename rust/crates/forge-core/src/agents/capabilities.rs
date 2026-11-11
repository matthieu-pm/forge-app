//! The production registry's descriptors and normalized capability inputs.
use crate::contract::*;
use serde_json::{Value, json};
use std::sync::LazyLock;

static DESCRIPTORS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../agent-capabilities.json"))
        .expect("source-exported capability descriptors")
});
pub fn descriptors() -> &'static [Value] {
    &DESCRIPTORS
}
pub fn descriptor(id: &str, version: &str) -> Option<&'static Value> {
    DESCRIPTORS
        .iter()
        .find(|v| v["id"] == id && v["version"] == version)
}
pub fn input(id: &str, v: Value) -> Result<Value> {
    match id {
        "teams.list" => {
            let mut o = Object::new(v, &["cursor", "limit"], true)?;
            o.optional("cursor", string)?;
            o.default("limit", json!(50), |v| number(v, 1., 100., true))?;
            Ok(o.finish())
        }
        "teams.get" => {
            let mut o = Object::new(v, &["id", "slug"], true)?;
            o.optional("id", uuid)?;
            o.optional("slug", |v| text(v, 1, 64, true))?;
            let v = o.finish();
            if v.get("id").is_some() == v.get("slug").is_some() {
                return Err(ContractError("selector"));
            }
            Ok(v)
        }
        "workspace.describe" => Ok(Object::new(v, &[], true)?.finish()),
        "teams.update" => {
            let mut o = Object::new(v, &["slug", "settings"], true)?;
            o.required("slug", slug)?;
            o.required("settings", |v| {
                crate::teams::TeamSettings::parse(v)
                    .map_err(|_| ContractError("settings"))
                    .and_then(|v| serde_json::to_value(v).map_err(|_| ContractError("settings")))
            })?;
            Ok(o.finish())
        }
        "artifacts.create" => super::contracts::artifact(v),
        _ => Err(ContractError("capability")),
    }
}
pub fn failure(code: &str, message: &str) -> Value {
    json!({"ok":false,"errorCode":code,"errorMessage":message})
}

fn slug(v: Value) -> Result<Value> {
    let v = text(v, 1, usize::MAX, true)?;
    let value = v.as_str().unwrap().to_lowercase();
    if !crate::teams::valid_slug(&value) {
        return Err(ContractError("slug"));
    }
    Ok(json!(value))
}
fn team(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "slug",
            "identifier",
            "name",
            "icon",
            "timezone",
            "description",
            "visibility",
            "estimationScheme",
            "issueEmailEnabled",
            "detailedHistoryEnabled",
            "createdAt",
        ],
        true,
    )?;
    o.required("id", uuid)?;
    o.required("slug", slug)?;
    for key in ["identifier", "name", "timezone", "description"] {
        o.required(key, string)?;
    }
    o.required("icon", |v| {
        let mut icon: crate::teams::TeamIcon =
            serde_json::from_value(v).map_err(|_| ContractError("icon"))?;
        icon.normalize().map_err(|_| ContractError("icon"))?;
        serde_json::to_value(icon).map_err(|_| ContractError("icon"))
    })?;
    o.required("visibility", |v| enumeration(v, &["workspace", "private"]))?;
    o.required("estimationScheme", |v| {
        enumeration(v, &["none", "exponential", "fibonacci", "linear", "tshirt"])
    })?;
    o.required("issueEmailEnabled", boolean)?;
    o.required("detailedHistoryEnabled", boolean)?;
    o.required("createdAt", datetime)?;
    Ok(o.finish())
}
pub fn output(id: &str, v: Value) -> Result<Value> {
    match id {
        "teams.list" => {
            let mut o = Object::new(v, &["items", "nextCursor"], true)?;
            o.required("items", |v| list(v, 0, usize::MAX, team))?;
            o.required("nextCursor", |v| nullable(v, string))?;
            Ok(o.finish())
        }
        "teams.get" => nullable(v, team),
        "teams.update" => team(v),
        "workspace.describe" => {
            let mut o = Object::new(v, &["id", "name", "slug", "actorRole"], true)?;
            for key in ["id", "name", "slug", "actorRole"] {
                o.required(key, |v| text(v, 1, usize::MAX, false))?;
            }
            Ok(o.finish())
        }
        "artifacts.create" => {
            let mut o = Object::new(
                v,
                &[
                    "id",
                    "runId",
                    "kind",
                    "name",
                    "contentType",
                    "sizeBytes",
                    "checksum",
                    "retentionExpiresAt",
                    "deletedAt",
                    "createdAt",
                ],
                true,
            )?;
            for key in ["id", "runId"] {
                o.required(key, uuid)?;
            }
            o.required("kind", |v| {
                enumeration(v, &["file", "text", "data", "report", "code"])
            })?;
            o.required("name", string)?;
            o.required("contentType", string)?;
            o.required("sizeBytes", integer)?;
            o.required("checksum", |v| pattern(v, "^[a-f0-9]{64}$"))?;
            for key in ["retentionExpiresAt", "deletedAt"] {
                o.required(key, |v| nullable(v, datetime))?;
            }
            o.required("createdAt", datetime)?;
            Ok(o.finish())
        }
        _ => Err(ContractError("capability")),
    }
}
