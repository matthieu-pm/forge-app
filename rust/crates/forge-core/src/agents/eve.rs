//! EVE wire events become Forge's public event vocabulary before persistence.
use crate::{
    canonical::javascript_stringify,
    contract::{self as c, ContractError, Result},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_token: Option<String>,
    pub stream_index: u64,
}
impl Cursor {
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(javascript_stringify(&json!(self)))
    }
    pub fn decode(value: &str) -> Option<Self> {
        let bytes = super::files::decode_artifact(value, true);
        let v = crate::json::parse(&String::from_utf8_lossy(&bytes)).ok()?;
        let mut object =
            c::Object::new(v, &["sessionId", "continuationToken", "streamIndex"], false).ok()?;
        object
            .required("sessionId", |v| c::text(v, 1, usize::MAX, false))
            .ok()?;
        object
            .optional("continuationToken", |v| c::text(v, 1, usize::MAX, false))
            .ok()?;
        object.required("streamIndex", c::integer).ok()?;
        serde_json::from_value(object.finish()).ok()
    }
}
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or(ContractError("object"))
}
fn text<'a>(value: &'a Value, key: &'static str, min: usize) -> Result<&'a str> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(ContractError(key))?;
    if crate::text::length(value) < min {
        return Err(ContractError(key));
    }
    Ok(value)
}
fn optional(
    value: &Value,
    key: &'static str,
    parse: impl FnOnce(Value) -> Result<Value>,
) -> Result<()> {
    if let Some(value) = value.get(key) {
        parse(value.clone())?;
    }
    Ok(())
}
fn copy(target: &mut Value, target_key: &str, source: &Value, key: &str) {
    if let Some(value) = source.get(key) {
        target[target_key] = value.clone();
    }
}
fn js(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js(Some(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(v) => javascript_stringify(v),
    }
}
fn source(
    session: &str,
    kind: &str,
    data: &Value,
    suffix: Option<&str>,
    index: Option<f64>,
) -> String {
    let sequence = index
        .map(|i| format!("stream-{}", js(Some(&json!(i)))))
        .unwrap_or_else(|| {
            data.get("sequence")
                .filter(|v| v.is_number())
                .map_or("unsequenced".into(), |v| js(Some(v)))
        });
    format!(
        "{session}:{kind}:{sequence}{}",
        suffix
            .filter(|s| !s.is_empty())
            .map_or(String::new(), |s| format!(":{s}"))
    )
}
fn event(id: String, kind: &str, at: Option<&Value>, payload: Value) -> Value {
    let mut result = json!({"sourceEventId":id,"source":"eve","type":kind,"payload":payload});
    if let Some(at) = at {
        result["occurredAt"] = at.clone();
    }
    result
}
fn action_type(tool: Option<&str>, phase: &str) -> &'static str {
    if phase == "failed" {
        return "tool.failed";
    }
    match (tool, phase) {
        (Some("bash" | "execute_program"), "started") => "code.started",
        (Some("bash" | "execute_program"), _) => "code.completed",
        (Some("glob" | "grep"), "started") => "file.search.started",
        (Some("glob" | "grep"), _) => "file.search.completed",
        (Some("read_file"), "completed") => "file.read",
        (Some("write_file"), "started") => "file.patch.proposed",
        (Some("write_file"), _) => "file.patch.applied",
        (_, "started") => "tool.started",
        _ => "tool.completed",
    }
}
fn action(value: &Value, input: bool) -> Result<()> {
    object(value)?;
    text(value, "callId", 0)?;
    text(value, "kind", 0)?;
    optional(value, "toolName", c::string)?;
    if input {
        optional(value, "input", c::record)?;
    }
    Ok(())
}
fn input_request(value: &Value) -> Result<()> {
    object(value)?;
    text(value, "requestId", 1)?;
    text(value, "prompt", 1)?;
    optional(value, "display", |v| {
        c::enumeration(v, &["confirmation", "select", "text"])
    })?;
    optional(value, "allowFreeform", c::boolean)?;
    optional(value, "options", |v| {
        c::list(v, 0, usize::MAX, |v| {
            object(&v)?;
            text(&v, "id", 0)?;
            text(&v, "label", 0)?;
            Ok(v)
        })
    })?;
    let mut action = c::Object::new(
        value["action"].clone(),
        &["callId", "kind", "toolName", "input"],
        true,
    )?;
    for key in ["callId", "toolName"] {
        action.required(key, |v| c::text(v, 1, usize::MAX, false))?;
    }
    action.required("kind", |v| c::enumeration(v, &["tool-call"]))?;
    action.required("input", c::record)?;
    Ok(())
}
fn unwrapped(value: &Value) -> &Value {
    if value.is_object() && value["type"] == "json" {
        &value["value"]
    } else {
        value
    }
}
pub fn basic(value: &Value) -> Result<()> {
    object(value)?;
    text(value, "type", 0)?;
    optional(value, "data", c::record)?;
    Ok(())
}
pub fn normalize(value: Value, session: &str, index: Option<f64>) -> Result<Vec<Value>> {
    basic(&value)?;
    if let Some(meta) = value.get("_meta") {
        object(meta)?;
        optional(meta, "at", c::string)?;
    }
    let kind = value["type"].as_str().unwrap();
    let empty = json!({});
    let data = value.get("data").unwrap_or(&empty);
    let at = value.get("_meta").and_then(|v| v.get("at"));
    let id = |suffix: Option<&str>| source(session, kind, data, suffix, index);
    let one = |kind: &str, payload: Value| Ok(vec![event(id(None), kind, at, payload)]);
    match kind {
        "message.appended" | "message.completed" => {
            let mut payload = json!({"messageId":format!("{}:{}",js(data.get("turnId")),js(data.get("stepIndex")))});
            if kind == "message.appended" {
                copy(&mut payload, "delta", data, "messageDelta");
                one("assistant.delta", payload)
            } else {
                copy(&mut payload, "content", data, "message");
                copy(&mut payload, "finishReason", data, "finishReason");
                one("assistant.message", payload)
            }
        }
        "step.completed" => {
            let Some(usage) = data.get("usage") else {
                return Ok(Vec::new());
            };
            object(usage)?;
            for key in [
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
            ] {
                optional(usage, key, c::integer)?;
            }
            optional(usage, "costUsd", |v| c::number(v, 0., f64::MAX, false))?;
            let count = |key: &str| usage[key].as_f64().unwrap_or(0.) as u64;
            let cost = crate::json::parse(&javascript_stringify(&json!(
                (usage["costUsd"].as_f64().unwrap_or(0.) * 1_000_000.).round()
            )))
            .map_err(|_| ContractError("cost"))?;
            one(
                "run.usage",
                json!({"inputTokens":count("inputTokens"),"outputTokens":count("outputTokens"),"cachedInputTokens":count("cacheReadTokens"),"cacheWriteTokens":count("cacheWriteTokens"),"costMicros":cost}),
            )
        }
        "actions.requested" => {
            let actions = data["actions"].as_array().ok_or(ContractError("actions"))?;
            let mut events = Vec::new();
            for entry in actions {
                action(entry, true)?;
                let mut payload = json!({"callId":entry["callId"],"kind":entry["kind"]});
                copy(&mut payload, "toolName", entry, "toolName");
                copy(&mut payload, "input", entry, "input");
                events.push(event(
                    id(entry["callId"].as_str()),
                    action_type(entry["toolName"].as_str(), "started"),
                    at,
                    payload,
                ));
            }
            Ok(events)
        }
        "action.result" => {
            let result = &data["result"];
            action(result, false)?;
            let tool = result["toolName"].as_str();
            let failed = matches!(data["status"].as_str(), Some("failed" | "rejected"));
            let mut events = Vec::new();
            let call_id = result["callId"].as_str().unwrap();
            let output = unwrapped(&result["output"]);
            if !failed
                && tool == Some("execute_program")
                && let Some(calls) = output["calls"].as_array()
            {
                for (index, call) in calls.iter().enumerate() {
                    if let Some(capability) = call["capabilityId"].as_str() {
                        let nested = format!("{call_id}:program:{index}");
                        let mut payload =
                            json!({"callId":nested,"toolName":capability,"programCallId":call_id});
                        copy(&mut payload, "input", call, "input");
                        copy(&mut payload, "output", call, "result");
                        events.push(event(id(Some(&nested)), "tool.completed", at, payload));
                    }
                }
            }
            if !failed
                && tool == Some("create_artifact")
                && let Some(artifact) = output["id"].as_str()
            {
                events.push(event(
                    format!("artifact:{artifact}"),
                    "artifact.created",
                    at,
                    output.clone(),
                ));
            }
            let mut payload = json!({"callId":call_id,"kind":result["kind"]});
            copy(&mut payload, "toolName", result, "toolName");
            copy(&mut payload, "status", data, "status");
            if failed {
                payload["error"] = json!("The tool execution failed.");
                payload["code"] = json!("CAPABILITY_EXECUTION_FAILED");
            } else {
                copy(&mut payload, "output", result, "output");
            }
            events.push(event(
                id(Some(call_id)),
                action_type(tool, if failed { "failed" } else { "completed" }),
                at,
                payload,
            ));
            Ok(events)
        }
        "authorization.required" => {
            let risk = js(data.get("risk"));
            let risk = if ["reversible-write", "important-write", "destructive"]
                .contains(&risk.as_str())
            {
                risk.as_str()
            } else {
                "important-write"
            };
            let mut payload = json!({"capabilityId":data["capabilityId"].as_str().unwrap_or("eve.authorization"),"capabilityVersion":data["capabilityVersion"].as_str().unwrap_or("1"),"risk":risk,"summary":data["summary"].as_str().or_else(||data["message"].as_str()).unwrap_or("Allow the requested Forge action"),"input":if data["input"].is_object()||data["input"].is_array(){data["input"].clone()}else{json!({})},"details":data});
            if data["expiresAt"].is_string() {
                copy(&mut payload, "expiresAt", data, "expiresAt");
            }
            one("approval.requested", payload)
        }
        "input.requested" => {
            let requests = data["requests"]
                .as_array()
                .ok_or(ContractError("requests"))?;
            let mut events = Vec::new();
            for request in requests {
                input_request(request)?;
                let (kind, payload) = if request["display"] == "confirmation" {
                    let action = &request["action"];
                    let tool = action["toolName"].as_str().unwrap();
                    let (capability, risk) = match tool {
                        "update_team" => ("teams.update".into(), "reversible-write"),
                        "execute_program" => ("program.execute".into(), "reversible-write"),
                        _ => (format!("eve.tool.{tool}"), "important-write"),
                    };
                    let mut details = json!({"runtimeRequestId":request["requestId"],"callId":action["callId"],"toolName":tool});
                    copy(&mut details, "options", request, "options");
                    if tool == "execute_program" && action["input"]["capabilityManifest"].is_array()
                    {
                        details["programManifest"] = action["input"]["capabilityManifest"].clone();
                    }
                    (
                        "approval.requested",
                        json!({"capabilityId":capability,"capabilityVersion":"1","risk":risk,"summary":request["prompt"],"input":action["input"],"details":details}),
                    )
                } else {
                    (
                        "run.waiting",
                        json!({"reason":"input-required","request":request}),
                    )
                };
                events.push(event(id(request["requestId"].as_str()), kind, at, payload));
            }
            Ok(events)
        }
        "turn.cancelled" => one("run.cancelled", json!({})),
        "turn.failed" | "session.failed" => one(
            "run.failed",
            json!({"code":"RUNTIME_EXECUTION_FAILED","message":"The agent runtime could not complete this run."}),
        ),
        _ => Ok(Vec::new()),
    }
}
