//! A provider search is settled inside a model receipt, never dispatched through
//! the Forge capability gateway. Its opaque history is confined to this run.
use super::{State, state::INVALID};
use crate::{Result, model::request::Protocol};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(super) struct Searches {
    pub actions: Vec<Value>,
    pub results: Vec<Value>,
    pub sources: Vec<Value>,
    pub continue_model: bool,
}
pub(super) fn inspect(parts: &[Value], protocol: Protocol) -> Result<Searches> {
    let mut calls = HashMap::new();
    let mut ids = HashSet::new();
    let mut completed = HashSet::new();
    let mut actions = vec![];
    let mut results = vec![];
    let mut sources = vec![];
    let mut last_result = None;
    let mut last_text = None;
    for (index, part) in parts.iter().enumerate() {
        match part["type"].as_str() {
            Some("tool-call") => {
                let id = part["toolCallId"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 1024)
                    .ok_or(INVALID)?;
                if !ids.insert(id) || ids.len() > 128 {
                    return Err(INVALID);
                }
                if part["providerExecuted"] == true {
                    if part["toolName"] != "web_search"
                        || protocol == Protocol::Chat
                        || !part["input"].is_object()
                        || protocol == Protocol::Responses && part["input"] != json!({})
                        || protocol == Protocol::Anthropic && !part["input"]["query"].is_string()
                    {
                        return Err(INVALID);
                    }
                    calls.insert(id, part);
                    actions.push(json!({"callId":id,"kind":"tool-call","toolName":"web_search","input":part["input"]}));
                }
            }
            Some("tool-result") => {
                let id = part["toolCallId"].as_str().ok_or(INVALID)?;
                if part["toolName"] != "web_search"
                    || !calls.contains_key(id)
                    || !completed.insert(id)
                {
                    return Err(INVALID);
                }
                crate::model::search::validate_output(protocol, &part["output"])?;
                results.push(json!({"callId":id,"kind":"tool-call","toolName":"web_search","output":materialized_output(&part["output"])}));
                last_result = Some(index);
            }
            Some("text") => {
                if !forge_core::text::trim(part["text"].as_str().ok_or(INVALID)?).is_empty() {
                    last_text = Some(index);
                }
                if let Some(values) = part["providerOptions"]["forge"]["sources"].as_array() {
                    sources.extend_from_slice(values);
                }
            }
            _ => {}
        }
    }
    if calls.len() != completed.len() {
        return Err(INVALID);
    }
    Ok(Searches {
        actions,
        results,
        sources,
        continue_model: last_result.is_some_and(|r| last_text.is_none_or(|t| r > t)),
    })
}
/// Opaque provider documents are needed only by the same bound model connection.
/// Human-readable results and errors remain available in receipts and later turns.
fn materialized_output(output: &Value) -> Value {
    let mut output = output.clone();
    if let Some(items) = output["value"].as_array_mut() {
        for item in items {
            if let Some(object) = item.as_object_mut() {
                object.remove("encryptedContent");
            }
        }
    }
    output
}
impl State {
    pub(super) fn materialize_search_history(messages: Vec<Value>) -> Vec<Value> {
        let mut output = vec![];
        for message in messages {
            if message["role"] != "assistant" || !message["content"].is_array() {
                output.push(message);
                continue;
            }
            let mut assistant = vec![];
            let mut results = vec![];
            for original in message["content"].as_array().unwrap() {
                let mut part = original.clone();
                if part["type"] == "tool-result" && part["toolName"] == "web_search" {
                    part["output"] = materialized_output(&part["output"]);
                    part.as_object_mut().unwrap().remove("providerOptions");
                    results.push(part);
                    continue;
                }
                if part["type"] == "tool-call" && part["providerExecuted"] == true {
                    part.as_object_mut().unwrap().remove("providerExecuted");
                }
                // Retain readable citation links even when a provider's item IDs
                // and encrypted annotations cannot cross the next model binding.
                let links = part["providerOptions"]["forge"]["sources"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|s| s["url"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    });
                assistant.push(part);
                if let Some(links) = links.filter(|v| !v.is_empty()) {
                    assistant.push(json!({"type":"text","text":format!("Sources referenced in the preceding text:\n{links}")}));
                }
            }
            // Collect all calls in one assistant message before materialized
            // results, so mixed host/search calls remain a valid tool exchange.
            if !assistant.is_empty() {
                output.push(json!({"role":"assistant","content":assistant}));
            }
            if !results.is_empty() {
                output.push(json!({"role":"tool","content":results}));
            }
        }
        output
    }
}
