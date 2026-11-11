//! Pure context compaction planning. A model summary is requested explicitly;
//! the engine owns its persistence, cancellation and usage policy.
pub mod prompt;
use forge_core::{canonical::javascript_stringify, text::trim};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::LazyLock;
pub const CHECKPOINT: &str = "Summary of our conversation so far:";
pub const CONTINUE: &str = "Continue.";
pub const DEFAULT_THRESHOLD: u64 = 100_000;
static OVERHEAD: LazyLock<f64> = LazyLock::new(|| {
    estimate(&json!([
        {"content":prompt::SYSTEM,"role":"system"},
        {"content":prompt::envelope("",""),"role":"user"}
    ]))
});
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub threshold: u64,
    pub recent_window: usize,
}
impl Config {
    pub fn is_valid(self) -> bool {
        self.threshold > 0 && self.threshold <= 9_007_199_254_740_991 && self.recent_window <= 10000
    }
}
/// The harness stores checkpoint/user strings; the provider boundary uses AI
/// SDK content parts. Keep the stored representation for checkpoint detection.
pub fn model_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let mut message = message.clone();
            if matches!(message["role"].as_str(), Some("user" | "assistant"))
                && let Some(content) = message["content"].as_str()
            {
                message["content"] = json!([{"type":"text","text":content}]);
            }
            message
        })
        .collect()
}
impl Default for Config {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_THRESHOLD,
            recent_window: 10,
        }
    }
}
pub fn estimate(value: &Value) -> f64 {
    utf16_len(&javascript_stringify(value)) as f64 / 4.
}
pub fn input_count(messages: &[Value], reported: Option<f64>, count: Option<f64>) -> f64 {
    match (reported, count) {
        (Some(reported), Some(count))
            if count.is_finite()
                && count.fract() == 0.
                && count >= 0.
                && count <= messages.len() as f64 =>
        {
            reported + estimate(&json!(&messages[count as usize..]))
        }
        _ => estimate(&json!(messages)),
    }
}
pub fn should_compact(
    messages: &[Value],
    config: Config,
    reported: Option<f64>,
    count: Option<f64>,
) -> bool {
    !messages.is_empty()
        && input_count(messages, reported, count) + *OVERHEAD > config.threshold as f64
}
pub enum Plan {
    Complete(Vec<Value>),
    Summarize(Summary),
}
pub struct Summary {
    conversation: Vec<Value>,
    previous: Option<String>,
    window: usize,
    config: Config,
}
impl Plan {
    pub fn new(messages: &[Value], config: Config, force: bool) -> Self {
        let (conversation, previous) = if messages.len() >= 2
            && messages[0]["role"] == "user"
            && messages[0]["content"] == CHECKPOINT
            && messages[1]["role"] == "assistant"
        {
            (messages[2..].to_vec(), Some(assistant_text(&messages[1])))
        } else {
            (messages.to_vec(), None)
        };
        let window = recent_window(&conversation, config, force);
        let summary = Summary {
            conversation,
            previous,
            window,
            config,
        };
        if !force {
            let (older, recent) = summary.split();
            if older.is_empty() && summary.previous.is_none() {
                return Self::Complete(without_tools(recent));
            }
            let mut candidate = summary
                .previous
                .as_ref()
                .map(|p| checkpoint(p))
                .unwrap_or_default();
            candidate.extend(cap_tool_results(older));
            candidate.extend_from_slice(recent);
            let candidate = resumption(candidate, &summary.conversation);
            if estimate(&json!(candidate)) + *OVERHEAD <= config.threshold as f64 {
                return Self::Complete(candidate);
            }
        }
        Self::Summarize(summary)
    }
}
impl Summary {
    fn split(&self) -> (&[Value], &[Value]) {
        let mut split = self.conversation.len().saturating_sub(self.window);
        while split < self.conversation.len() && self.conversation[split]["role"] == "tool" {
            split += 1;
        }
        self.conversation.split_at(split)
    }
    pub fn prompt(&self) -> prompt::Prompt {
        prompt::create(
            self.split().0,
            self.previous.as_deref(),
            Some(self.config.threshold as f64),
        )
    }
    pub fn accept(mut self, summary: &str) -> Plan {
        let (_, recent) = self.split();
        let mut candidate = checkpoint(summary);
        candidate.extend_from_slice(recent);
        let candidate = resumption(candidate, &self.conversation);
        if estimate(&json!(candidate)) <= self.config.threshold as f64 {
            return Plan::Complete(candidate);
        }
        let mut reduced = checkpoint(summary);
        reduced.extend(without_tools(recent));
        let reduced = resumption(reduced, &self.conversation);
        if estimate(&json!(reduced)) <= self.config.threshold as f64 || self.window == 0 {
            return Plan::Complete(reduced);
        }
        self.window -= 1;
        Plan::Summarize(self)
    }
}
fn checkpoint(summary: &str) -> Vec<Value> {
    vec![
        json!({"content":CHECKPOINT,"role":"user"}),
        json!({"content":summary,"role":"assistant"}),
    ]
}
fn recent_window(messages: &[Value], config: Config, force: bool) -> usize {
    let max = (if force { 1 } else { config.recent_window }).min(messages.len().saturating_sub(1));
    let reserve = (config.threshold / 4).clamp(64, 2048) as f64;
    let mut total = 0.;
    let mut count = 0;
    for message in messages.iter().rev().take(max) {
        let tokens = estimate(&json!([message]));
        if total + tokens + reserve > config.threshold as f64 {
            break;
        }
        total += tokens;
        count += 1;
    }
    count
}
fn cap_tool_results(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(|message| {
        let mut message = message.clone();
        if message["role"] == "tool" && let Some(parts) = message["content"].as_array_mut() {
            for part in parts {
                if part["type"] == "tool-result" {
                    let output = prompt::stub_files(&part["output"]);
                    let serialized = javascript_stringify(&output);
                    part["output"] = if utf16_len(&serialized) <= 2000 { output } else { json!({"type":"text","value":format!("[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]\n\n{}",utf16_prefix(&serialized,2000))}) };
                }
            }
        }
        message
    }).collect()
}
fn assistant_text(message: &Value) -> String {
    if let Some(text) = message["content"].as_str() {
        return trim(text).into();
    }
    trim(
        &message["content"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|p| p["type"] == "text")
            .map(|p| p["text"].as_str().unwrap_or(""))
            .collect::<String>(),
    )
    .to_owned()
}
fn without_tools(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            if message["role"] == "tool" {
                return None;
            }
            if message["role"] != "assistant" {
                return Some(message.clone());
            }
            let text = assistant_text(message);
            (!text.is_empty()).then(|| json!({"content":text,"role":"assistant"}))
        })
        .collect()
}
fn resumption(mut messages: Vec<Value>, original: &[Value]) -> Vec<Value> {
    if messages.last().is_some_and(|m| m["role"] != "assistant") {
        return messages;
    }
    let user = original.iter().rev().find(|m| {
        m["role"] == "user"
            && m["content"].as_str().is_some_and(|s| {
                s != CONTINUE
                    && s != CHECKPOINT
                    && !s.starts_with(forge_core::agents::context::PRESERVATION_LABEL)
            })
    });
    if let Some(user) = user
        && !messages
            .iter()
            .any(|m| m["role"] == "user" && m["content"] == user["content"])
    {
        messages.push(user.clone());
    } else {
        messages.push(json!({"content":CONTINUE,"role":"user"}));
    }
    messages
}
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
fn utf16_prefix(text: &str, limit: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(limit).collect::<Vec<_>>())
}
