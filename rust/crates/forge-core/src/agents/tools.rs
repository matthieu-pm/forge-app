//! Authored runtime tools use their source schemas before the independently
//! stricter application capability boundary. Unknown fields are stripped only
//! where the original authored tool schema strips them.
use crate::contract::*;
use serde_json::{Value, json};
use std::sync::LazyLock;
static DESCRIPTORS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/runtime-tools.json"))
        .expect("source runtime tool definitions")
});
pub fn descriptors() -> &'static [Value] {
    &DESCRIPTORS
}
pub fn input(name: &str, v: Value) -> Result<Value> {
    match name {
        "list_teams" => {
            let mut o = Object::new(v, &["cursor", "limit"], false)?;
            o.optional("cursor", string)?;
            o.default("limit", json!(50), |v| number(v, 1., 100., true))?;
            Ok(o.finish())
        }
        "get_team" => {
            let mut o = Object::new(v, &["id", "slug"], false)?;
            o.optional("id", uuid)?;
            o.optional("slug", |v| text(v, 1, usize::MAX, false))?;
            let v = o.finish();
            if v.get("id").is_some() == v.get("slug").is_some() {
                return Err(ContractError("selector"));
            }
            Ok(v)
        }
        "describe_workspace" => Ok(Object::new(v, &[], false)?.finish()),
        "update_team" => {
            let mut o = Object::new(v, &["slug", "settings"], true)?;
            o.required("slug", |v| {
                let v = text(v, 1, usize::MAX, true)?;
                pattern(
                    json!(v.as_str().unwrap().to_lowercase()),
                    "^[a-z0-9]+(?:-[a-z0-9]+)*$",
                )
            })?;
            o.required("settings", |v| {
                let mut s = Object::new(
                    v,
                    &[
                        "name",
                        "identifier",
                        "description",
                        "timezone",
                        "estimationScheme",
                        "issueEmailEnabled",
                        "detailedHistoryEnabled",
                    ],
                    true,
                )?;
                s.optional("name", |v| text(v, 1, 80, true))?;
                s.optional("identifier", |v| {
                    pattern(text(v, 0, usize::MAX, true)?, "^[A-Za-z][A-Za-z0-9]{0,4}$")
                })?;
                s.optional("description", |v| text(v, 0, 500, true))?;
                s.optional("timezone", |v| text(v, 1, 100, true))?;
                s.optional("estimationScheme", |v| {
                    enumeration(v, &["none", "exponential", "fibonacci", "linear", "tshirt"])
                })?;
                s.optional("issueEmailEnabled", boolean)?;
                s.optional("detailedHistoryEnabled", boolean)?;
                let v = s.finish();
                if v.as_object().unwrap().is_empty() {
                    return Err(ContractError("settings"));
                }
                Ok(v)
            })?;
            Ok(o.finish())
        }
        "create_artifact" => {
            let mut o = Object::new(
                v,
                &["kind", "name", "contentType", "encoding", "content"],
                false,
            )?;
            o.default("kind", json!("file"), |v| {
                enumeration(v, &["file", "text", "data", "report", "code"])
            })?;
            o.required("name", |v| text(v, 1, 200, true))?;
            o.required("contentType", |v| text(v, 1, 120, true))?;
            o.default("encoding", json!("utf8"), |v| {
                enumeration(v, &["utf8", "base64"])
            })?;
            o.required("content", |v| text(v, 0, 8000000, false))?;
            Ok(o.finish())
        }
        "run_code" => super::sandbox::run_code(v),
        "execute_program" => super::sandbox::program(v),
        _ => Err(ContractError("tool")),
    }
}
pub fn needs_approval(name: &str, input: &Value) -> bool {
    name == "update_team"
        || name == "execute_program"
            && input["capabilityManifest"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["id"] == "teams.update"))
}
fn team(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "slug",
            "identifier",
            "name",
            "timezone",
            "description",
        ],
        false,
    )?;
    o.required("id", uuid)?;
    for field in ["slug", "identifier", "name", "timezone", "description"] {
        o.required(field, string)?;
    }
    Ok(o.finish())
}
pub fn output(name: &str, v: Value) -> Result<Value> {
    match name {
        "list_teams" => {
            let mut o = Object::new(v, &["items", "nextCursor"], false)?;
            o.required("items", |v| list(v, 0, usize::MAX, team))?;
            o.required("nextCursor", |v| nullable(v, string))?;
            Ok(o.finish())
        }
        "get_team" => nullable(v, team),
        "update_team" => team(v),
        "describe_workspace" => {
            let mut o = Object::new(v, &["id", "name", "slug", "actorRole"], false)?;
            for f in ["id", "name", "slug", "actorRole"] {
                o.required(f, string)?;
            }
            Ok(o.finish())
        }
        // Application artifact output has already crossed the public capability
        // schema: use its required ISO dates/checksum before exposing it to models.
        "create_artifact" => {
            let o = Object::new(
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
                false,
            )?;
            super::capabilities::output("artifacts.create", o.finish())
        }
        _ => Err(ContractError("tool output")),
    }
}
