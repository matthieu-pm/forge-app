use super::*;
use crate::contract::*;
use serde_json::{Value, json};
pub fn create_thread(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["title", "runtimeKind"], true)?;
    o.optional("title", |v| text(v, 1, 160, true))?;
    o.default("runtimeKind", json!("eve"), |v| enumeration(v, RUNTIMES))?;
    Ok(o.finish())
}
pub fn turn(v: Value, local: bool) -> Result<Value> {
    let mut o = Object::new(
        v,
        if local {
            &[
                "runtimeId",
                "threadId",
                "message",
                "model",
                "reasoningEffort",
                "attachmentIds",
            ]
        } else {
            &[
                "threadId",
                "message",
                "selectionMode",
                "model",
                "reasoningEffort",
                "attachmentIds",
                "preferredOpenAIConnectionId",
            ]
        },
        true,
    )?;
    o.required("threadId", uuid)?;
    o.required("message", |v| text(v, 1, 100000, true))?;
    o.default("attachmentIds", json!([]), |v| list(v, 0, 20, uuid))?;
    if local {
        o.required("runtimeId", |v| enumeration(v, &["codex", "claude"]))?;
        o.required("model", models::reference)?;
        o.default("reasoningEffort", json!("medium"), |v| {
            enumeration(v, EFFORTS)
        })?;
    } else {
        o.required("selectionMode", |v| enumeration(v, &["auto", "manual"]))?;
        o.optional("model", models::reference)?;
        o.optional("reasoningEffort", |v| enumeration(v, EFFORTS))?;
        o.optional("preferredOpenAIConnectionId", uuid)?;
    }
    let v = o.finish();
    if local {
        if v["model"]["executionKind"] != "external-agent"
            || !v["model"]["selectionId"]
                .as_str()
                .unwrap()
                .starts_with(&format!("local:{}:", v["runtimeId"].as_str().unwrap()))
        {
            return Err(ContractError("local model"));
        }
    } else {
        let manual = v["selectionMode"] == "manual";
        if manual != v.get("model").is_some()
            || (manual && v.get("preferredOpenAIConnectionId").is_some())
        {
            return Err(ContractError("selection"));
        }
    }
    Ok(v)
}
pub fn resolve_approval(v: Value, bound: bool) -> Result<Value> {
    let mut o = Object::new(
        v,
        if bound {
            &["approvalId", "decision", "inputHash"]
        } else {
            &["decision"]
        },
        true,
    )?;
    o.required("decision", |v| enumeration(v, &["approved", "denied"]))?;
    if bound {
        o.required("approvalId", uuid)?;
        o.required("inputHash", hash)?;
    }
    Ok(o.finish())
}
fn hash(v: Value) -> Result<Value> {
    pattern(v, "^[a-f0-9]{64}$")
}
pub fn command(v: Value) -> Result<Value> {
    let kind = v["type"].as_str().unwrap_or("").to_owned();
    let mut o = Object::new(v, &["type", "input"], true)?;
    o.required("type", |v| {
        enumeration(
            v,
            &[
                "thread.create",
                "turn.start",
                "run.cancel",
                "approval.resolve",
                "thread.rename",
                "thread.archive",
                "thread.reopen",
            ],
        )
    })?;
    o.required("input", |v| match kind.as_str() {
        "thread.create" => create_thread(v),
        "turn.start" => turn(v, false),
        "approval.resolve" => resolve_approval(v, true),
        _ => {
            let run = kind == "run.cancel";
            let rename = kind == "thread.rename";
            let mut o = Object::new(
                v,
                if run {
                    &["runId"]
                } else if rename {
                    &["threadId", "title"]
                } else {
                    &["threadId"]
                },
                true,
            )?;
            o.required(if run { "runId" } else { "threadId" }, uuid)?;
            if rename {
                o.required("title", |v| text(v, 1, 160, true))?;
            }
            Ok(o.finish())
        }
    })?;
    Ok(o.finish())
}
pub fn event(v: Value, append: bool, local: bool) -> Result<Value> {
    let mut keys = vec!["sourceEventId", "source", "type", "occurredAt", "payload"];
    if !local {
        keys.extend(["threadId", "runId", "schemaVersion"]);
        if !append {
            keys.extend(["id", "sequence"]);
        }
    }
    let mut o = Object::new(v, &keys, true)?;
    o.required("sourceEventId", |v| text(v, 1, 255, true))?;
    o.required("source", |v| {
        enumeration(
            v,
            if local {
                &["codex", "claude"]
            } else {
                &["eve", "codex", "claude", "forge"]
            },
        )
    })?;
    o.required("type", |v| enumeration(v, EVENTS))?;
    o.required("occurredAt", datetime)?;
    o.required("payload", record)?;
    if !local {
        for key in ["threadId", "runId"] {
            o.required(key, uuid)?;
        }
        o.default("schemaVersion", json!(1), |v| {
            number(v, 1., 9007199254740991., true)
        })?;
        if !append {
            o.required("id", uuid)?;
            o.required("sequence", |v| number(v, 1., 9007199254740991., true))?;
        }
    }
    Ok(o.finish())
}
pub fn local_events(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["runId", "events"], true)?;
    o.required("runId", uuid)?;
    o.required("events", |v| list(v, 1, 100, |v| event(v, false, true)))?;
    Ok(o.finish())
}
pub fn checkpoint(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["runtimeSessionId", "runtimeRunId"], true)?;
    for key in ["runtimeSessionId", "runtimeRunId"] {
        o.required(key, |v| text(v, 1, 255, true))?;
    }
    Ok(o.finish())
}
pub fn local_tool(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["runId", "namespace", "tool", "arguments"], true)?;
    o.required("runId", uuid)?;
    o.required("namespace", |v| enumeration(v, &["forge"]))?;
    o.required("tool", |v| {
        enumeration(v, &["teams_list", "teams_get", "workspace_describe"])
    })?;
    o.required("arguments", record)?;
    Ok(o.finish())
}
pub fn runtime_approval(v: Value, local: bool) -> Result<Value> {
    let keys = &[
        "approvalId",
        "capabilityId",
        "capabilityVersion",
        "risk",
        "summary",
        "input",
        "details",
        "expiresAt",
    ];
    let extras = v
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| !keys.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    let mut o = Object::new(v, keys, false)?;
    if local {
        o.required("approvalId", uuid)?;
        o.required("expiresAt", datetime)?;
    } else {
        o.optional("approvalId", uuid)?;
        o.optional("expiresAt", datetime)?;
    }
    o.required("capabilityId", |v| text(v, 1, 255, true))?;
    o.default("capabilityVersion", json!("1"), |v| text(v, 1, 50, true))?;
    o.required("risk", |v| enumeration(v, RISKS))?;
    o.required("summary", |v| text(v, 1, 20000, true))?;
    o.optional("input", record)?;
    o.default("details", json!({}), record)?;
    let mut v = o.finish();
    v.as_object_mut().unwrap().extend(extras);
    Ok(v)
}
pub fn capability(v: Value, descriptor: bool) -> Result<Value> {
    let mut o = Object::new(
        v,
        if descriptor {
            &[
                "id",
                "version",
                "summary",
                "risk",
                "inputSchema",
                "outputSchema",
                "maxResultBytes",
            ]
        } else {
            &[
                "capabilityId",
                "capabilityVersion",
                "input",
                "idempotencyKey",
                "approvalId",
            ]
        },
        true,
    )?;
    o.required(if descriptor { "id" } else { "capabilityId" }, |v| {
        text(v, 1, 255, true)
    })?;
    o.required(
        if descriptor {
            "version"
        } else {
            "capabilityVersion"
        },
        |v| text(v, 1, 50, true),
    )?;
    if descriptor {
        o.required("summary", |v| text(v, 1, 500, true))?;
        o.required("risk", |v| enumeration(v, RISKS))?;
        for key in ["inputSchema", "outputSchema"] {
            o.required(key, record)?;
        }
        o.required("maxResultBytes", |v| number(v, 1., 10485760., true))?;
    } else {
        o.required("input", record)?;
        o.optional("idempotencyKey", |v| text(v, 1, 255, true))?;
        o.optional("approvalId", uuid)?;
    }
    Ok(o.finish())
}
pub fn capability_result(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["ok", "value", "errorCode", "errorMessage"], true)?;
    o.required("ok", boolean)?;
    o.optional("value", Ok)?;
    o.optional("errorCode", |v| text(v, 1, 100, true))?;
    o.optional("errorMessage", |v| text(v, 1, 1000, true))?;
    let v = o.finish();
    let ok = v["ok"] == true;
    let code = v.get("errorCode").is_some();
    let message = v.get("errorMessage").is_some();
    if (ok && (code || message)) || (!ok && !(code && message)) {
        return Err(ContractError("result"));
    }
    Ok(v)
}
fn filename(v: Value) -> Result<Value> {
    let v = text(v, 1, 200, true)?;
    if v.as_str()
        .unwrap()
        .chars()
        .any(|c| c == '/' || c == '\\' || c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err(ContractError("file name"));
    }
    Ok(v)
}
pub fn artifact(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &["kind", "name", "contentType", "encoding", "content"],
        true,
    )?;
    o.default("kind", json!("file"), |v| {
        enumeration(v, &["file", "text", "data", "report", "code"])
    })?;
    o.required("name", filename)?;
    o.required("contentType", |v| {
        let v = text(v, 1, 120, true)?;
        pattern(
            v,
            "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$",
        )
    })?;
    o.default("encoding", json!("utf8"), |v| {
        enumeration(v, &["utf8", "base64"])
    })?;
    o.required("content", |v| text(v, 0, 8000000, false))?;
    Ok(o.finish())
}
pub fn attachment(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["name", "contentType", "contentBase64"], true)?;
    o.required("name", filename)?;
    o.required("contentType", |v| {
        let v = string(v)?;
        enumeration(
            json!(crate::text::trim(v.as_str().unwrap()).to_lowercase()),
            &[
                "application/json",
                "application/pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "image/gif",
                "image/jpeg",
                "image/png",
                "image/webp",
                "text/csv",
                "text/markdown",
                "text/plain",
            ],
        )
    })?;
    o.required("contentBase64", |v| {
        pattern(text(v, 1, 8000000, false)?, "^[a-zA-Z0-9+/]*={0,2}$")
    })?;
    Ok(o.finish())
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum UnsafePayload {
    #[error("Store large tool output as an artifact instead of an inline event.")]
    TooLarge,
    #[error("Agent events cannot contain credentials or authentication data.")]
    Sensitive,
}
pub fn safe_payload(payload: &Value) -> std::result::Result<(), UnsafePayload> {
    use std::sync::LazyLock;
    static KEY: LazyLock<regress::Regex> = LazyLock::new(|| {
        regress::Regex::with_flags(r"(?:^|[-_])(authorization|cookie|password|secret|token|api[-_]?key|private[-_]?key)(?:$|[-_])","i").unwrap()
    });
    static VALUE: LazyLock<regress::Regex> = LazyLock::new(|| {
        regress::Regex::with_flags(r"(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*|\b(?:sk|xai)-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)","i").unwrap()
    });
    if crate::canonical::javascript_stringify(payload).len() > 128 * 1024 {
        return Err(UnsafePayload::TooLarge);
    }
    let mut queue = vec![payload];
    while let Some(v) = queue.pop() {
        match v {
            Value::String(s) if VALUE.find(s).is_some() => return Err(UnsafePayload::Sensitive),
            Value::Array(a) => queue.extend(a),
            Value::Object(o) => {
                for (k, v) in o {
                    if !k.is_empty() && KEY.find(k).is_some() {
                        return Err(UnsafePayload::Sensitive);
                    }
                    queue.push(v);
                }
            }
            _ => {}
        }
    }
    Ok(())
}
