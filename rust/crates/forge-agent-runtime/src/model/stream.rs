//! Interpretation of the three provider protocols used by Forge. Tool calls are
//! returned only after a complete terminal response, never from a JSON prefix.
use super::request::Protocol;
use crate::{Error, Result};
use forge_core::canonical::javascript_stringify;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const INVALID: Error = Error("The model returned an invalid or incomplete response.");
const LIMIT: usize = 4 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delta {
    Text {
        id: String,
        text: String,
    },
    Reasoning {
        id: String,
        text: String,
    },
    ToolInput {
        id: String,
        name: String,
        text: String,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other,
}
impl Finish {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::ToolCalls => "tool-calls",
            Self::Length => "length",
            Self::ContentFilter => "content-filter",
            Self::Other => "other",
        }
    }
}
pub struct Completion {
    /// AI SDK conversation parts accepted by `request::build`.
    pub content: Vec<Value>,
    pub finish: Finish,
    /// Public aggregate counters only. Provider error bodies and raw usage are
    /// never returned through this boundary.
    pub usage: Value,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Reasoning,
    Tool,
}
struct Block {
    kind: Kind,
    id: String,
    item_id: Option<String>,
    name: String,
    text: String,
    metadata: Value,
    closed: bool,
    incomplete: bool,
}
impl Block {
    fn new(kind: Kind, id: String) -> Self {
        Self {
            kind,
            id,
            item_id: None,
            name: String::new(),
            text: String::new(),
            metadata: json!({}),
            closed: false,
            incomplete: false,
        }
    }
    fn append(&mut self, text: &str) -> Result<Delta> {
        if self.closed || self.text.len() + text.len() > LIMIT {
            return Err(INVALID);
        }
        self.text.push_str(text);
        Ok(match self.kind {
            Kind::Text => Delta::Text {
                id: self.id.clone(),
                text: text.into(),
            },
            Kind::Reasoning => Delta::Reasoning {
                id: self.id.clone(),
                text: text.into(),
            },
            Kind::Tool => Delta::ToolInput {
                id: self.id.clone(),
                name: self.name.clone(),
                text: text.into(),
            },
        })
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(INVALID)
}
fn optional_text<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>> {
    if value[key].is_null() {
        Ok(None)
    } else {
        Ok(Some(text(value, key)?))
    }
}
fn identity(value: &Value, key: &str) -> Result<String> {
    let s = text(value, key)?;
    if s.is_empty() || s.len() > 1024 {
        return Err(INVALID);
    }
    Ok(s.into())
}
fn index(value: &Value, key: &str) -> Result<u64> {
    value[key].as_u64().filter(|i| *i < 1024).ok_or(INVALID)
}
fn counter(value: &Value) -> Result<Option<u64>> {
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(
        value
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(INVALID)?,
    ))
}
fn count(value: &Value, key: &str) -> Result<u64> {
    Ok(counter(&value[key])?.unwrap_or(0))
}
fn usage(protocol: Protocol, value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(
            json!({"inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"reasoningTokens":null}),
        );
    }
    if !value.is_object() {
        return Err(INVALID);
    }
    let (input, output, read, write, reasoning) = match protocol {
        Protocol::Chat => (
            count(value, "prompt_tokens")?,
            count(value, "completion_tokens")?,
            Some(count(&value["prompt_tokens_details"], "cached_tokens")?),
            counter(&value["prompt_tokens_details"]["cache_write_tokens"])?,
            Some(count(
                &value["completion_tokens_details"],
                "reasoning_tokens",
            )?),
        ),
        Protocol::Responses => (
            count(value, "input_tokens")?,
            count(value, "output_tokens")?,
            Some(count(&value["input_tokens_details"], "cached_tokens")?),
            counter(&value["input_tokens_details"]["cache_write_tokens"])?,
            Some(count(&value["output_tokens_details"], "reasoning_tokens")?),
        ),
        Protocol::Anthropic => {
            let mut input = count(value, "input_tokens")?;
            let mut output = count(value, "output_tokens")?;
            if let Some(iterations) = value["iterations"]
                .as_array()
                .filter(|v| !v.iter().any(|i| i["type"] == "fallback_message"))
            {
                let executor: Vec<_> = iterations
                    .iter()
                    .filter(|i| i["type"] == "compaction" || i["type"] == "message")
                    .collect();
                if !executor.is_empty() {
                    input = 0;
                    output = 0;
                    for i in executor {
                        input = input
                            .checked_add(count(i, "input_tokens")?)
                            .ok_or(INVALID)?;
                        output = output
                            .checked_add(count(i, "output_tokens")?)
                            .ok_or(INVALID)?;
                    }
                }
            }
            let read = count(value, "cache_read_input_tokens")?;
            let write = count(value, "cache_creation_input_tokens")?;
            (
                input
                    .checked_add(read)
                    .and_then(|n| n.checked_add(write))
                    .ok_or(INVALID)?,
                output,
                Some(read),
                Some(write),
                counter(&value["output_tokens_details"]["thinking_tokens"])?,
            )
        }
    };
    if input > 9_007_199_254_740_991 || output > 9_007_199_254_740_991 {
        return Err(INVALID);
    }
    Ok(
        json!({"inputTokens":input,"outputTokens":output,"cacheReadTokens":read,"cacheWriteTokens":write,"reasoningTokens":reasoning}),
    )
}

pub struct Parser {
    protocol: Protocol,
    blocks: BTreeMap<u64, Block>,
    response_id: Option<String>,
    finish: Option<Finish>,
    terminal: bool,
    raw_usage: Value,
    bytes: usize,
    failed: bool,
}
impl Parser {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            blocks: BTreeMap::new(),
            response_id: None,
            finish: None,
            terminal: false,
            raw_usage: Value::Null,
            bytes: 0,
            failed: false,
        }
    }
    fn insert(&mut self, index: u64, block: Block) -> Result<()> {
        if self.blocks.len() >= 128
            || self.blocks.contains_key(&index)
            || self.blocks.values().any(|b| b.id == block.id)
        {
            return Err(INVALID);
        }
        self.blocks.insert(index, block);
        Ok(())
    }
    fn by_item(&mut self, id: &str) -> Result<&mut Block> {
        self.blocks
            .values_mut()
            .find(|b| b.item_id.as_deref() == Some(id))
            .ok_or(INVALID)
    }
    pub fn push(&mut self, data: &str) -> Result<Vec<Delta>> {
        if self.failed {
            return Err(INVALID);
        }
        let result = self.push_inner(data);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn push_inner(&mut self, data: &str) -> Result<Vec<Delta>> {
        self.bytes = self.bytes.checked_add(data.len()).ok_or(INVALID)?;
        if self.bytes > 32 * 1024 * 1024 {
            return Err(INVALID);
        }
        if data == "[DONE]" {
            if self.finish.is_none()
                || self.protocol == Protocol::Anthropic
                || (self.protocol == Protocol::Responses && !self.terminal)
            {
                return Err(INVALID);
            }
            self.terminal = true;
            return Ok(vec![]);
        }
        if self.terminal {
            return Err(INVALID);
        }
        let value = forge_core::json::parse(data).map_err(|_| INVALID)?;
        if !value.is_object() || !value["error"].is_null() {
            return Err(INVALID);
        }
        let result = match self.protocol {
            Protocol::Responses => self.responses(value),
            Protocol::Chat => self.chat(value),
            Protocol::Anthropic => self.anthropic(value),
        }?;
        let size = self
            .blocks
            .values()
            .map(|b| b.text.len() + javascript_stringify(&b.metadata).len())
            .sum::<usize>();
        if size > LIMIT {
            return Err(INVALID);
        }
        Ok(result)
    }
    fn responses(&mut self, value: Value) -> Result<Vec<Delta>> {
        let mut out = vec![];
        match text(&value, "type")? {
            "response.created" => {
                if self.response_id.is_some() {
                    return Err(INVALID);
                }
                self.response_id = Some(identity(&value["response"], "id")?);
            }
            "response.output_item.added" => {
                if self.response_id.is_none() {
                    return Err(INVALID);
                }
                let item = &value["item"];
                let item_id = identity(item, "id")?;
                if self
                    .blocks
                    .values()
                    .any(|b| b.item_id.as_ref() == Some(&item_id))
                {
                    return Err(INVALID);
                }
                let kind = match text(item, "type")? {
                    "message" => Kind::Text,
                    "reasoning" => Kind::Reasoning,
                    "function_call" => Kind::Tool,
                    _ => return Err(INVALID),
                };
                let mut b = Block::new(
                    kind,
                    if kind == Kind::Tool {
                        identity(item, "call_id")?
                    } else {
                        item_id.clone()
                    },
                );
                b.item_id = Some(item_id.clone());
                b.metadata = json!({"openai":{"itemId":item_id}});
                if let Some(phase) = item.get("phase").filter(|v| !v.is_null()) {
                    b.metadata["openai"]["phase"] = phase.clone();
                }
                if kind == Kind::Tool {
                    b.name = identity(item, "name")?;
                    let initial = text(item, "arguments")?;
                    if !initial.is_empty() {
                        out.push(b.append(initial)?);
                    }
                }
                self.insert(index(&value, "output_index")?, b)?;
            }
            "response.output_text.delta"
            | "response.reasoning_summary_text.delta"
            | "response.function_call_arguments.delta" => {
                let expected = match text(&value, "type")? {
                    "response.output_text.delta" => Kind::Text,
                    "response.reasoning_summary_text.delta" => Kind::Reasoning,
                    _ => Kind::Tool,
                };
                let b = self.by_item(text(&value, "item_id")?)?;
                if b.kind != expected {
                    return Err(INVALID);
                }
                out.push(b.append(text(&value, "delta")?)?);
            }
            "response.output_item.done" => {
                let item = &value["item"];
                let b = self
                    .blocks
                    .get_mut(&index(&value, "output_index")?)
                    .ok_or(INVALID)?;
                if b.closed || b.item_id.as_deref() != Some(text(item, "id")?) {
                    return Err(INVALID);
                }
                let expected = match b.kind {
                    Kind::Text => "message",
                    Kind::Reasoning => "reasoning",
                    Kind::Tool => "function_call",
                };
                if text(item, "type")? != expected {
                    return Err(INVALID);
                }
                if b.kind == Kind::Tool {
                    b.incomplete = match text(item, "status")? {
                        "completed" => false,
                        "incomplete" => true,
                        _ => return Err(INVALID),
                    };
                    if b.id != text(item, "call_id")? || b.name != text(item, "name")? {
                        return Err(INVALID);
                    }
                    let arguments = text(item, "arguments")?;
                    if b.text.is_empty() {
                        out.push(b.append(arguments)?);
                    } else if b.text != arguments {
                        return Err(INVALID);
                    }
                }
                b.closed = true;
            }
            "response.completed" | "response.incomplete" => {
                if self.response_id.is_none() || self.blocks.values().any(|b| !b.closed) {
                    return Err(INVALID);
                }
                let response = &value["response"];
                if let Some(id) = optional_text(response, "id")?
                    && self.response_id.as_deref() != Some(id)
                {
                    return Err(INVALID);
                }
                let calls = self.blocks.values().any(|b| b.kind == Kind::Tool);
                self.finish = Some(match response["incomplete_details"]["reason"].as_str() {
                    None => {
                        if calls {
                            Finish::ToolCalls
                        } else {
                            Finish::Stop
                        }
                    }
                    Some("max_output_tokens") => Finish::Length,
                    Some("content_filter") => Finish::ContentFilter,
                    _ => {
                        if calls {
                            Finish::ToolCalls
                        } else {
                            Finish::Other
                        }
                    }
                });
                self.raw_usage = response["usage"].clone();
                self.terminal = true;
            }
            "response.in_progress"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.done"
            | "response.function_call_arguments.done" => {}
            _ => return Err(INVALID),
        }
        Ok(out)
    }
    fn chat(&mut self, value: Value) -> Result<Vec<Delta>> {
        let mut out = vec![];
        if let Some(id) = optional_text(&value, "id")? {
            if self.response_id.as_deref().is_some_and(|v| v != id) {
                return Err(INVALID);
            }
            self.response_id = Some(id.into());
        }
        if !value["usage"].is_null() {
            self.raw_usage = value["usage"].clone();
        }
        let choices = value["choices"].as_array().ok_or(INVALID)?;
        if choices.len() > 1 {
            return Err(INVALID);
        }
        if let Some(choice) = choices.first() {
            if choice["index"] != 0 || self.finish.is_some() {
                return Err(INVALID);
            }
            let delta = &choice["delta"];
            if !delta.is_null() && !delta.is_object() {
                return Err(INVALID);
            }
            if !delta["content"].is_null() {
                if !self.blocks.contains_key(&0) {
                    self.insert(0, Block::new(Kind::Text, "0".into()))?;
                }
                out.push(
                    self.blocks
                        .get_mut(&0)
                        .unwrap()
                        .append(text(delta, "content")?)?,
                );
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for call in calls {
                    if !call["type"].is_null() && call["type"] != "function" {
                        return Err(INVALID);
                    }
                    let i = index(call, "index")? + 1;
                    let function = &call["function"];
                    if !self.blocks.contains_key(&i) {
                        let mut b = Block::new(Kind::Tool, identity(call, "id")?);
                        b.name = identity(function, "name")?;
                        self.insert(i, b)?;
                    }
                    let b = self.blocks.get_mut(&i).unwrap();
                    if optional_text(call, "id")?.is_some_and(|id| id != b.id)
                        || optional_text(function, "name")?.is_some_and(|name| name != b.name)
                    {
                        return Err(INVALID);
                    }
                    if !function["arguments"].is_null() {
                        out.push(b.append(text(function, "arguments")?)?);
                    }
                }
            } else if !delta["tool_calls"].is_null() {
                return Err(INVALID);
            }
            if let Some(reason) = optional_text(choice, "finish_reason")? {
                self.finish = Some(match reason {
                    "stop" => Finish::Stop,
                    "tool_calls" | "function_call" => Finish::ToolCalls,
                    "length" => Finish::Length,
                    "content_filter" => Finish::ContentFilter,
                    _ => Finish::Other,
                });
                for b in self.blocks.values_mut() {
                    b.closed = true;
                }
            }
        }
        Ok(out)
    }
    fn anthropic(&mut self, value: Value) -> Result<Vec<Delta>> {
        let mut out = vec![];
        match text(&value, "type")? {
            "ping" => {}
            "message_start" => {
                if self.response_id.is_some() {
                    return Err(INVALID);
                }
                let m = &value["message"];
                self.response_id = Some(identity(m, "id")?);
                self.raw_usage = m["usage"].clone();
                if m["content"].as_array().is_some_and(|a| !a.is_empty()) {
                    return Err(INVALID);
                }
            }
            "content_block_start" => {
                if self.response_id.is_none() || self.finish.is_some() {
                    return Err(INVALID);
                }
                let i = index(&value, "index")?;
                let block = &value["content_block"];
                let kind = match text(block, "type")? {
                    "text" => Kind::Text,
                    "thinking" | "redacted_thinking" => Kind::Reasoning,
                    "tool_use" => Kind::Tool,
                    _ => return Err(INVALID),
                };
                let mut b = Block::new(
                    kind,
                    if kind == Kind::Tool {
                        identity(block, "id")?
                    } else {
                        i.to_string()
                    },
                );
                if kind == Kind::Tool {
                    b.name = identity(block, "name")?;
                    if let Some(object) = block["input"].as_object() {
                        if !object.is_empty() {
                            out.push(b.append(&javascript_stringify(&block["input"]))?);
                        }
                    } else if !block["input"].is_null() {
                        return Err(INVALID);
                    }
                    if !block["caller"].is_null() && block["caller"]["type"] != "direct" {
                        return Err(INVALID);
                    }
                } else if block["type"] == "redacted_thinking" {
                    b.metadata = json!({"anthropic":{"redactedData":text(block,"data")?}});
                }
                self.insert(i, b)?;
            }
            "content_block_delta" => {
                let b = self
                    .blocks
                    .get_mut(&index(&value, "index")?)
                    .ok_or(INVALID)?;
                let d = &value["delta"];
                let (kind, key) = match text(d, "type")? {
                    "text_delta" => (Kind::Text, "text"),
                    "thinking_delta" => (Kind::Reasoning, "thinking"),
                    "input_json_delta" => (Kind::Tool, "partial_json"),
                    "signature_delta" => {
                        if b.kind != Kind::Reasoning
                            || b.closed
                            || !b.metadata["anthropic"]["redactedData"].is_null()
                        {
                            return Err(INVALID);
                        }
                        let signature = text(d, "signature")?;
                        let prior = b.metadata["anthropic"]["signature"].as_str().unwrap_or("");
                        if prior.len() + signature.len() > LIMIT {
                            return Err(INVALID);
                        }
                        b.metadata =
                            json!({"anthropic":{"signature":format!("{prior}{signature}")}});
                        return Ok(out);
                    }
                    _ => return Err(INVALID),
                };
                if b.kind != kind {
                    return Err(INVALID);
                }
                out.push(b.append(text(d, key)?)?);
            }
            "content_block_stop" => {
                let b = self
                    .blocks
                    .get_mut(&index(&value, "index")?)
                    .ok_or(INVALID)?;
                if b.closed {
                    return Err(INVALID);
                }
                if b.kind == Kind::Tool && b.text.is_empty() {
                    b.text = "{}".into();
                }
                b.closed = true;
            }
            "message_delta" => {
                if self.response_id.is_none()
                    || self.finish.is_some()
                    || self.blocks.values().any(|b| !b.closed)
                {
                    return Err(INVALID);
                }
                let update = value["usage"].as_object().ok_or(INVALID)?;
                let target = self.raw_usage.as_object_mut().ok_or(INVALID)?;
                for (key, value) in update {
                    target.insert(key.clone(), value.clone());
                }
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.finish = Some(match reason {
                        "end_turn" | "stop_sequence" | "pause_turn" => Finish::Stop,
                        "tool_use" => Finish::ToolCalls,
                        "max_tokens" | "model_context_window_exceeded" => Finish::Length,
                        "refusal" => Finish::ContentFilter,
                        _ => Finish::Other,
                    });
                }
            }
            "message_stop" => {
                if self.finish.is_none() {
                    return Err(INVALID);
                }
                self.terminal = true;
            }
            _ => return Err(INVALID),
        }
        Ok(out)
    }
    pub fn finish(self) -> Result<Completion> {
        if self.failed {
            return Err(INVALID);
        }
        let finish = self.finish.ok_or(INVALID)?;
        if (self.protocol != Protocol::Chat && !self.terminal)
            || self.blocks.values().any(|b| !b.closed)
        {
            return Err(INVALID);
        }
        let mut content = vec![];
        for b in self.blocks.into_values() {
            let mut part = match b.kind {
                Kind::Text => json!({"type":"text","text":b.text}),
                Kind::Reasoning => json!({"type":"reasoning","text":b.text}),
                Kind::Tool => {
                    if b.incomplete {
                        if matches!(
                            finish,
                            Finish::Length | Finish::ContentFilter | Finish::Other
                        ) {
                            continue;
                        }
                        return Err(INVALID);
                    }
                    // An empty/partial argument stream is never an executable call.
                    let input = forge_core::json::parse(&b.text)
                        .ok()
                        .filter(Value::is_object);
                    let Some(input) = input else {
                        if matches!(
                            finish,
                            Finish::Length | Finish::ContentFilter | Finish::Other
                        ) {
                            continue;
                        }
                        return Err(INVALID);
                    };
                    json!({"type":"tool-call","toolCallId":b.id,"toolName":b.name,"input":input})
                }
            };
            if b.metadata.as_object().is_some_and(|v| !v.is_empty()) {
                part["providerOptions"] = b.metadata;
            }
            content.push(part);
        }
        Ok(Completion {
            content,
            finish,
            usage: usage(self.protocol, &self.raw_usage)?,
        })
    }
}
