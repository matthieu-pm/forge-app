use crate::{Error, Result, auth::Channel, model::request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(super) const INVALID: Error =
    Error("The agent continuation is invalid or belongs to a different run.");
const INSTRUCTIONS: &str =
    include_str!("../../../../../services/agent-runtime/agent/instructions.md");
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Ready,
    Generating,
    Tools,
    Waiting,
    Complete,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Approved,
    Denied,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CallPhase {
    Queued,
    Calling,
    Waiting,
    Complete,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Call {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub input_hash: Option<String>,
    pub phase: CallPhase,
    pub request_id: Option<String>,
    pub decision: Option<Decision>,
    pub output: Option<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    user: String,
    workspace: String,
    run: String,
    provider: String,
    model: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub(super) version: u32,
    binding: Binding,
    pub(super) revision: u64,
    pub(super) phase: Phase,
    pub(super) step: u64,
    pub(super) messages: Vec<Value>,
    pub(super) calls: Vec<Call>,
    pub(super) next_call: usize,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
}
impl State {
    /// `history` is trusted stored conversation history, never a client-supplied
    /// system prompt. The owner has already resolved and authorized attachments.
    pub fn new(channel: &Channel, history: Vec<Value>) -> Result<Self> {
        if history.is_empty() || history.iter().any(|v| v["role"] == "system") {
            return Err(INVALID);
        }
        let mut messages = vec![json!({"role":"system","content":INSTRUCTIONS})];
        messages.extend(history);
        let state = Self {
            version: 1,
            binding: Binding {
                user: channel.principal_id().into(),
                workspace: channel.workspace_id().into(),
                run: channel.run_id().into(),
                provider: channel.provider().into(),
                model: channel.model_id().into(),
            },
            revision: 0,
            phase: Phase::Ready,
            step: 0,
            messages,
            calls: vec![],
            next_call: 0,
            input_tokens: 0,
            output_tokens: 0,
        };
        state.validate(channel)?;
        Ok(state)
    }
    /// Restore only from the owner's private journal, not an HTTP request body.
    pub fn restore(snapshot: Value, channel: &Channel) -> Result<Self> {
        if forge_core::canonical::javascript_stringify(&snapshot).len() > 8 * 1024 * 1024 {
            return Err(INVALID);
        }
        let mut state: Self = serde_json::from_value(snapshot).map_err(|_| INVALID)?;
        // A new deployment supplies the current instructions while preserving
        // the private conversation and any exact pending tool input binding.
        if state
            .messages
            .first()
            .is_some_and(|v| v["role"] == "system" && v["content"].is_string())
        {
            state.messages[0] = json!({"role":"system","content":INSTRUCTIONS});
        }
        state.validate(channel)?;
        Ok(state)
    }
    pub fn snapshot(&self) -> Value {
        serde_json::to_value(self).expect("serializable agent state")
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub(super) fn run_id(&self) -> &str {
        &self.binding.run
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn history(&self) -> &[Value] {
        &self.messages
    }
    pub fn usage(&self) -> (u64, u64) {
        (self.input_tokens, self.output_tokens)
    }
    pub fn pending_request(&self) -> Option<&str> {
        if self.phase != Phase::Waiting {
            return None;
        }
        self.calls.get(self.next_call)?.request_id.as_deref()
    }
    pub(crate) fn validate(&self, channel: &Channel) -> Result<()> {
        let b = &self.binding;
        if self.version != 1
            || b.user != channel.principal_id()
            || b.workspace != channel.workspace_id()
            || b.run != channel.run_id()
            || b.provider != channel.provider()
            || b.model != channel.model_id()
            || self.revision >= 9_007_199_254_740_991
            || self.step >= 9_007_199_254_740_991
            || self.calls.len() > 128
            || self.next_call > self.calls.len()
            || self.input_tokens > 9_007_199_254_740_991
            || self.output_tokens > 9_007_199_254_740_991
        {
            return Err(INVALID);
        }
        if self.messages.first() != Some(&json!({"role":"system","content":INSTRUCTIONS})) {
            return Err(INVALID);
        }
        request::build(channel, &self.messages, &[], None).map_err(|_| INVALID)?;
        if self.phase == Phase::Waiting
            && !self.calls.get(self.next_call).is_some_and(|c| {
                c.phase == CallPhase::Waiting
                    && c.request_id.is_some()
                    && c.input_hash.is_some()
                    && c.decision.is_none()
            })
        {
            return Err(INVALID);
        }
        let mut ids = std::collections::HashSet::new();
        for (index, c) in self.calls.iter().enumerate() {
            if c.id.is_empty()
                || c.id.len() > 1024
                || c.name.is_empty()
                || c.name.len() > 1024
                || !c.input.is_object()
                || !ids.insert(&c.id)
                || (index < self.next_call
                    && (c.phase != CallPhase::Complete || c.output.is_none()))
            {
                return Err(INVALID);
            }
            if let Some(hash) = &c.input_hash {
                let input = forge_core::agents::tools::input(&c.name, c.input.clone())
                    .map_err(|_| INVALID)?;
                if input != c.input || forge_core::agents::approval::input_hash(&input) != *hash {
                    return Err(INVALID);
                }
            }
        }
        Ok(())
    }
}
