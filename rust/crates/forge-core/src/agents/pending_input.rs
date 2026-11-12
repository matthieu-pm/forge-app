//! Pure EVE pending-input decisions. `approved_keys` reproduces SDK bookkeeping;
//! it is never a Forge capability grant or authorization to execute a tool.
use super::input;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid pending runtime input.")]
pub struct Error;
pub type Result<T> = std::result::Result<T, Error>;
pub type ApprovalKey<'a> = &'a dyn Fn(&Value) -> Option<String>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingBatch {
    pub requests: Vec<Value>,
    pub response_messages: Vec<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub event: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<PendingBatch>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub deferred_input: Option<Value>,
    /// Historical source keys only. Consumers must enforce canonical grants.
    #[serde(default)]
    pub approved_keys: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Continue,
    Unresolved,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitContinuation {
    pub granted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RejectedActions {
    pub event: Value,
    pub results: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub outcome: Outcome,
    pub state: PendingState,
    pub messages: Vec<Value>,
    pub tool_parts: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_message: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_message: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_continuation: Option<LimitContinuation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected_actions: Option<RejectedActions>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Consumed {
    pub state: PendingState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub input: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInput {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_message: Option<Value>,
}

/// The owning harness applies this after consuming deferred input and before
/// resolving the current batch. Earlier approvals become new conversation text;
/// the text explicitly carries no authority to execute the earlier action.
pub fn prepare_stale(
    history: &[Value],
    pending_ids: &[String],
    step_input: Option<&Value>,
) -> Result<PreparedInput> {
    let mut prepared = PreparedInput {
        kind: "unchanged".into(),
        step_input: step_input.cloned(),
        display_message: None,
    };
    let Some(step) = &mut prepared.step_input else {
        return Ok(prepared);
    };
    let Some(responses) = step.get("inputResponses") else {
        return Ok(prepared);
    };
    let responses = array(Some(responses))?;
    let retained = responses
        .iter()
        .filter(|response| {
            let id = response["requestId"].as_str().unwrap_or_default();
            pending_ids.iter().any(|pending| pending == id) || !source_limit_id(id)
        })
        .cloned()
        .collect::<Vec<_>>();
    if retained.len() != responses.len() {
        let object = step.as_object_mut().ok_or(Error)?;
        object.remove("inputResponses");
        if !retained.is_empty() {
            object.insert("inputResponses".into(), json!(retained));
        }
    }
    let (current, stale): (Vec<_>, Vec<_>) = retained.into_iter().partition(|response| {
        response["requestId"]
            .as_str()
            .is_some_and(|id| pending_ids.iter().any(|pending| pending == id))
    });
    if stale.is_empty() {
        return Ok(prepared);
    }
    let requests = historical_requests(history, &stale)?;
    let mut rows = vec![];
    let mut display = vec![];
    let mut warning = false;
    for response in &stale {
        let id = response["requestId"].as_str().ok_or(Error)?;
        let request = requests.get(id);
        let selected = request
            .and_then(|request| request.get("options"))
            .and_then(Value::as_array)
            .and_then(|options| {
                options
                    .iter()
                    .find(|option| option.get("id") == response.get("optionId"))
            });
        let mut answer = json!({});
        if let Some(option) = response.get("optionId") {
            answer["optionId"] = option.clone();
        }
        if let Some(option) = selected {
            let mut selected = json!({"id":option["id"],"label":option["label"]});
            if let Some(description) = option.get("description") {
                selected["description"] = description.clone();
            }
            answer["selectedOption"] = selected;
        }
        if let Some(text) = response.get("text") {
            answer["text"] = text.clone();
        }
        let mut row = json!({"requestId":id,"response":answer});
        if let Some(request) = request {
            row["prompt"] = request["prompt"].clone();
            row["requestType"] = json!(if request["kind"] == "tool-approval" {
                "approval"
            } else {
                "question"
            });
        }
        warning |= request.is_none_or(|request| request["kind"] == "tool-approval");
        rows.push(row);
        let text = response
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .or_else(|| selected.and_then(|option| option["label"].as_str()))
            .or_else(|| response["optionId"].as_str())
            .unwrap_or("Response to an earlier interactive prompt");
        display.push(text.to_owned());
    }
    let warning = if warning {
        " This does not authorize an earlier action; request approval again if that action is still needed."
    } else {
        ""
    };
    let model = format!(
        "The user submitted the following response to an earlier interactive prompt.\nTreat it as new input at the current point in the conversation and decide whether it is still relevant.{warning}\n{}",
        serde_json::to_string_pretty(&rows).map_err(|_| Error)?
    );
    let original = step.get("message");
    let model = append_optional(original, model)?;
    prepared.display_message = Some(append_optional(original, display.join("\n"))?);
    let object = step.as_object_mut().ok_or(Error)?;
    object.remove("inputResponses");
    object.insert("message".into(), model);
    if !current.is_empty() {
        object.insert("inputResponses".into(), json!(current));
    }
    prepared.kind = "converted".into();
    Ok(prepared)
}

fn source_limit_id(id: &str) -> bool {
    let Some((prefix, digits)) = id.rsplit_once(':') else {
        return false;
    };
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && (prefix.ends_with(":limit:input") || prefix.ends_with(":limit:output"))
}
fn append_optional(original: Option<&Value>, text: String) -> Result<Value> {
    Ok(match normalize_message(original)? {
        None => json!(text),
        Some(Value::String(original)) => json!(format!("{original}\n\n{text}")),
        Some(original) => {
            let mut parts = message_parts(original);
            parts.push(json!({"type":"text","text":text}));
            json!(parts)
        }
    })
}
fn historical_requests(
    history: &[Value],
    responses: &[Value],
) -> Result<std::collections::HashMap<String, Value>> {
    let wanted = responses
        .iter()
        .filter_map(|response| response["requestId"].as_str())
        .collect::<HashSet<_>>();
    let mut found = std::collections::HashMap::new();
    for message in history.iter().rev() {
        if message["role"] != "assistant" {
            continue;
        }
        let Some(parts) = message["content"].as_array() else {
            continue;
        };
        let calls = parts
            .iter()
            .filter(|part| part["type"] == "tool-call" && descriptor(part))
            .collect::<Vec<_>>();
        let mut requests = vec![];
        for call in &calls {
            if call["toolName"] != "ask_question"
                || !wanted.contains(call["toolCallId"].as_str().ok_or(Error)?)
            {
                continue;
            }
            let input = historical_input(call.get("input"))?;
            let mut request = json!({"requestId":call["toolCallId"],"kind":"question","prompt":source_string(input.get("prompt"))});
            if let Some(options) = input.get("options") {
                request["options"] = options.clone();
            }
            requests.push(request);
        }
        for part in parts {
            if part["type"] != "tool-approval-request" || part["isAutomatic"] == true {
                continue;
            }
            let Some(id) = part["approvalId"].as_str().filter(|id| wanted.contains(id)) else {
                continue;
            };
            let call = part
                .get("toolCall")
                .filter(|call| descriptor(call))
                .or_else(|| {
                    let id = part["toolCallId"].as_str()?;
                    calls
                        .iter()
                        .rev()
                        .find(|call| call["toolCallId"] == id)
                        .copied()
                });
            let Some(call) = call else {
                continue;
            };
            historical_input(call.get("input"))?;
            requests.push(json!({"requestId":id,"kind":"tool-approval","prompt":format!("Approve tool call: {}",call["toolName"].as_str().ok_or(Error)?),"options":[{"id":"approve","label":"Yes"},{"id":"deny","label":"No"}]}));
        }
        for request in requests {
            let id = request["requestId"].as_str().ok_or(Error)?.to_owned();
            found.entry(id).or_insert(request);
        }
        if found.len() == wanted.len() {
            break;
        }
    }
    Ok(found)
}
fn descriptor(value: &Value) -> bool {
    value.is_object() && value["toolCallId"].is_string() && value["toolName"].is_string()
}
fn historical_input(value: Option<&Value>) -> Result<Value> {
    let value = match value {
        None | Some(Value::Null) => json!({}),
        Some(Value::String(text)) if crate::text::trim(text).is_empty() => json!({}),
        Some(Value::String(text)) => crate::json::parse(text).map_err(|_| Error)?,
        Some(value) => value.clone(),
    };
    if value.is_object() {
        Ok(value)
    } else {
        Err(Error)
    }
}
fn source_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    source_string(Some(value))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(value) => crate::canonical::javascript_stringify(value),
    }
}

fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

pub fn is_required(request: &Value) -> bool {
    matches!(
        request["kind"].as_str(),
        Some("tool-approval" | "session-limit")
    )
}

pub fn has_step_input(input: Option<&Value>) -> bool {
    input.is_some_and(|input| {
        input.get("message").is_some() || nonempty(input.get("inputResponses"))
    })
}

/// Cancellation drops only a nonempty all-session-limit batch. Model-anchored
/// questions and tool approvals still need an explicit result in history.
pub fn clear_session_limit_prompt(state: &PendingState) -> PendingState {
    let mut next = state.clone();
    if next.batch.as_ref().is_some_and(|batch| {
        !batch.requests.is_empty()
            && batch
                .requests
                .iter()
                .all(|request| request["kind"] == "session-limit")
    }) {
        next.batch = None;
    }
    next
}

/// Call before resolving the next delivery, as the owning harness does. Queued
/// explicit responses are retained and suppress fresh text-to-option matching.
pub fn consume_deferred(state: &PendingState, input: Option<&Value>) -> Result<Consumed> {
    let mut state = state.clone();
    let input = match (state.deferred_input.take(), input) {
        (None, input) => input.cloned(),
        (Some(deferred), None) => Some(deferred),
        (Some(deferred), Some(input)) => Some(coalesce(&deferred, input)?),
    };
    Ok(Consumed { state, input })
}

/// Resolve already-validated request shapes without granting execution rights.
/// Unknown response IDs and duplicate matching retain the installed SDK rules.
pub fn resolve(
    state: &PendingState,
    history: &[Value],
    step_input: Option<&Value>,
    resolve_approval_key: Option<ApprovalKey<'_>>,
) -> Result<Resolution> {
    let mut result = Resolution {
        outcome: Outcome::Continue,
        state: state.clone(),
        messages: history.to_vec(),
        tool_parts: vec![],
        consumed_message: None,
        deferred_message: None,
        deferred_context: None,
        limit_continuation: None,
        rejected_actions: None,
    };
    let Some(batch) = &state.batch else {
        return Ok(result);
    };
    result.outcome = Outcome::Unresolved;
    let mut step = step_input.cloned();
    if let Some(value) = &step {
        let responses = array(value.get("inputResponses"))?;
        if let Some(text) = value.get("message").and_then(Value::as_str)
            && responses.is_empty()
        {
            let matched = input::resolve_text(text, &batch.requests);
            if !matched.is_empty() {
                let mut value = value.clone();
                let object = value.as_object_mut().ok_or(Error)?;
                object.insert("inputResponses".into(), json!(matched));
                object.insert("messageConsumed".into(), json!(true));
                object.remove("message");
                step = Some(compact(Some(&value)));
            }
        }
    }
    let responses = array(step.as_ref().and_then(|value| value.get("inputResponses")))?;
    let message = step.as_ref().and_then(|value| value.get("message"));
    if responses.is_empty() && message.is_none() {
        return Ok(result);
    }
    if batch.requests.iter().any(|request| {
        is_required(request)
            && !responses
                .iter()
                .any(|response| response.get("requestId") == request.get("requestId"))
    }) {
        queue(&mut result.state, compact(step.as_ref()))?;
        result.deferred_message = Some(true);
        return Ok(result);
    }
    result.outcome = Outcome::Resolved;
    result.consumed_message = step
        .as_ref()
        .and_then(|value| value.get("messageConsumed"))
        .and_then(Value::as_bool);
    result.tool_parts = tool_parts(batch, responses);
    result.messages.extend(batch.response_messages.clone());
    if !result.tool_parts.is_empty() {
        result
            .messages
            .push(json!({"role":"tool","content":result.tool_parts}));
    }
    result.rejected_actions = rejected_actions(batch, responses);
    result.state.batch = None;
    if responses.is_empty() {
        return Ok(result);
    }
    result.limit_continuation = batch
        .requests
        .iter()
        .find(|request| request["kind"] == "session-limit")
        .and_then(|request| {
            responses
                .iter()
                .find(|response| response.get("requestId") == request.get("requestId"))
        })
        .and_then(|response| match response["optionId"].as_str() {
            Some("continue") => Some(LimitContinuation { granted: true }),
            Some("stop") => Some(LimitContinuation { granted: false }),
            _ => None,
        });
    let mut keys = vec![];
    for request in &batch.requests {
        if responses.iter().any(|response| {
            response["optionId"] == "approve"
                && response.get("requestId") == request.get("requestId")
        }) {
            let key = resolve_approval_key
                .and_then(|resolve| resolve(request))
                .or_else(|| request["action"]["toolName"].as_str().map(str::to_owned))
                .ok_or(Error)?;
            keys.push(key);
        }
    }
    if !keys.is_empty() {
        let mut seen = HashSet::new();
        result.state.approved_keys = state
            .approved_keys
            .iter()
            .cloned()
            .chain(keys)
            .filter(|key| seen.insert(key.clone()))
            .collect();
    }
    if batch
        .requests
        .iter()
        .any(|request| request["kind"] == "tool-approval")
    {
        let context = step.as_ref().and_then(|value| value.get("context"));
        let has_context = nonempty(context);
        if has_context || message.is_some() {
            let mut deferred = json!({});
            if has_context {
                deferred["context"] = context.unwrap().clone();
            }
            if let Some(message) = message {
                deferred["message"] = message.clone();
            }
            queue(&mut result.state, deferred)?;
            result.deferred_context = has_context.then_some(true);
            result.deferred_message = message.is_some().then_some(true);
        }
    }
    Ok(result)
}

fn array(value: Option<&Value>) -> Result<&[Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err(Error),
    }
}
fn nonempty(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(values)) => !values.is_empty(),
        Some(Value::String(value)) => !value.is_empty(),
        _ => false,
    }
}
fn compact(input: Option<&Value>) -> Value {
    let mut result = json!({});
    if let Some(input) = input {
        for key in ["context", "inputResponses"] {
            if nonempty(input.get(key)) {
                result[key] = input[key].clone();
            }
        }
        for key in ["message", "outputSchema"] {
            if let Some(value) = input.get(key) {
                result[key] = value.clone();
            }
        }
        if input["messageConsumed"] == true {
            result["messageConsumed"] = json!(true);
        }
    }
    result
}
fn queue(state: &mut PendingState, input: Value) -> Result<()> {
    state.deferred_input = Some(match state.deferred_input.take() {
        Some(previous) => coalesce(&previous, &input)?,
        None => input,
    });
    Ok(())
}

/// Preserve the source merge ordering. In particular outputSchema uses nullish
/// fallback, and merging drops messageConsumed and unrelated step fields.
pub fn coalesce(first: &Value, second: &Value) -> Result<Value> {
    if first.is_null() || second.is_null() {
        return Err(Error);
    }
    let mut result = json!({});
    for key in ["inputResponses", "context"] {
        let values = array(first.get(key))?
            .iter()
            .chain(array(second.get(key))?)
            .cloned()
            .collect::<Vec<_>>();
        if !values.is_empty() {
            result[key] = json!(values);
        }
    }
    let first_message = normalize_message(first.get("message"))?;
    let second_message = normalize_message(second.get("message"))?;
    let message = match (first_message, second_message) {
        (Some(Value::String(first)), Some(Value::String(second))) => {
            Some(json!(format!("{first}\n\n{second}")))
        }
        (Some(first), Some(second)) => {
            let mut parts = message_parts(first);
            parts.extend(message_parts(second));
            Some(json!(parts))
        }
        (first, second) => first.or(second),
    };
    if let Some(message) = message {
        result["message"] = message;
    }
    if let Some(schema) = second
        .get("outputSchema")
        .filter(|value| !value.is_null())
        .or_else(|| first.get("outputSchema"))
    {
        result["outputSchema"] = schema.clone();
    }
    Ok(result)
}
fn normalize_message(value: Option<&Value>) -> Result<Option<Value>> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) => Ok((!crate::text::trim(text).is_empty()).then(|| json!(text))),
        Some(Value::Array(parts)) => {
            let mut result = vec![];
            for part in parts {
                if part.is_null() {
                    return Err(Error);
                }
                if part["type"] != "text"
                    || !crate::text::trim(part["text"].as_str().ok_or(Error)?).is_empty()
                {
                    result.push(part.clone());
                }
            }
            Ok((!result.is_empty()).then(|| json!(result)))
        }
        _ => Err(Error),
    }
}
fn message_parts(message: Value) -> Vec<Value> {
    match message {
        Value::String(text) => vec![json!({"type":"text","text":text})],
        Value::Array(parts) => parts,
        _ => vec![],
    }
}

struct ApprovalOutcome {
    approved: bool,
    reason: Option<&'static str>,
    status: &'static str,
}
fn approval_outcome(response: Option<&Value>) -> ApprovalOutcome {
    let (approved, reason, status) = match response {
        None => (
            false,
            Some("Ignored because the user continued without responding."),
            "ignored",
        ),
        Some(response) if response["optionId"] == "approve" => (true, None, "approved"),
        Some(response) if response["optionId"] == "deny" => {
            (false, Some("Tool execution was denied."), "denied")
        }
        _ => (false, Some("Invalid approval response."), "invalid"),
    };
    ApprovalOutcome {
        approved,
        reason,
        status,
    }
}
fn last_response<'a>(request: &Value, responses: &'a [Value]) -> Option<&'a Value> {
    responses
        .iter()
        .rev()
        .find(|response| response.get("requestId") == request.get("requestId"))
}
fn tool_parts(batch: &PendingBatch, responses: &[Value]) -> Vec<Value> {
    let mut parts = vec![];
    for request in &batch.requests {
        let response = last_response(request, responses);
        if request["kind"] == "session-limit" {
            continue;
        }
        if request["kind"] == "tool-approval" {
            let outcome = approval_outcome(response);
            let mut part = json!({"approvalId":request["requestId"],"approved":outcome.approved,"type":"tool-approval-response"});
            if let Some(reason) = outcome.reason {
                part["reason"] = json!(reason);
            }
            parts.push(part);
            if !outcome.approved {
                parts.push(json!({"output":{"type":"execution-denied","reason":outcome.reason},"toolCallId":request["action"]["callId"],"toolName":request["action"]["toolName"],"type":"tool-result"}));
            }
        } else {
            parts.push(json!({"output":{"type":"json","value":input::question_output(response)},"toolCallId":request["action"]["callId"],"toolName":request["action"]["toolName"],"type":"tool-result"}));
        }
    }
    parts
}
fn rejected_actions(batch: &PendingBatch, responses: &[Value]) -> Option<RejectedActions> {
    let event = batch.event.as_ref()?;
    let mut results = vec![];
    for request in &batch.requests {
        if request["kind"] != "tool-approval" {
            continue;
        }
        let outcome = approval_outcome(last_response(request, responses));
        if !outcome.approved {
            results.push(json!({"callId":request["action"]["callId"],"isError":true,"kind":"tool-result","output":{"approval":{"requestId":request["requestId"],"status":outcome.status},"code":"TOOL_EXECUTION_DENIED","message":outcome.reason.unwrap_or("Tool execution was denied."),"tool":{"result":"not_run"}},"toolName":request["action"]["toolName"]}));
        }
    }
    (!results.is_empty()).then(|| RejectedActions {
        event: event.clone(),
        results,
    })
}
