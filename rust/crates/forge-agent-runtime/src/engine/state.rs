use crate::{
    Error, Result, auth::Channel, framework::FileState, model::request, workspace::Reference,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) const INVALID: Error =
    Error("The agent continuation is invalid or belongs to a different run.");
const INSTRUCTIONS: &str =
    include_str!("../../../../../services/agent-runtime/agent/instructions.md");
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Ready,
    Generating,
    Compacting,
    Tools,
    Waiting,
    Complete,
    Cancelled,
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
    Cancelled,
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
    #[serde(default)]
    pub(super) decisions: BTreeMap<String, Decision>,
    #[serde(default)]
    pub(super) workspace: Option<Reference>,
    #[serde(default)]
    pub(super) files: FileState,
    #[serde(default)]
    pub(super) todos: Vec<Value>,
    #[serde(default)]
    pub(super) compaction: Compaction,
    #[serde(default)]
    pub(super) budget: super::budget::Budget,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Compaction {
    pub last_input_tokens: Option<u64>,
    pub last_prompt_messages: Option<usize>,
    pub active: Option<crate::context::Config>,
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
            decisions: BTreeMap::new(),
            workspace: Some(Reference::new()),
            files: FileState::default(),
            todos: vec![],
            compaction: Compaction::default(),
            budget: super::budget::Budget::default(),
        };
        state.validate(channel)?;
        Ok(state)
    }
    /// Restore only from the owner's private journal, not an HTTP request body.
    pub fn restore(snapshot: Value, channel: &Channel) -> Result<Self> {
        let state = Self::decode(snapshot)?;
        state.validate(channel)?;
        Ok(state)
    }
    pub(crate) fn restore_parent(snapshot: Value, channel: &Channel, parent: &str) -> Result<Self> {
        let state = Self::decode(snapshot)?;
        if state.binding.user != channel.principal_id()
            || state.binding.workspace != channel.workspace_id()
            || state.binding.run != parent
        {
            return Err(INVALID);
        }
        state.validate_structure()?;
        Ok(state)
    }
    fn decode(snapshot: Value) -> Result<Self> {
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
        Ok(state)
    }
    /// Only the owning journal may call this after observing a terminal or
    /// cancelled parent. Incomplete tools get explicit outcomes, never retries.
    pub(crate) fn next_history(&self) -> Vec<Value> {
        let mut messages = self.messages.iter().skip(1).cloned().collect::<Vec<_>>();
        if !self.calls.is_empty() {
            let results=self.calls.iter().map(|call| {
                let output=match call.phase {
                    CallPhase::Complete => call.output.clone().unwrap_or_else(||json!({"type":"error-text","value":"The previous tool result is unavailable."})),
                    CallPhase::Calling => json!({"type":"error-text","value":"The previous run ended before this tool's outcome could be confirmed. Check the current state before repeating the action."}),
                    _ => json!({"type":"execution-denied","reason":"The previous run ended before this tool was executed."}),
                };
                json!({"type":"tool-result","toolCallId":call.id,"toolName":call.name,"output":output})
            }).collect::<Vec<_>>();
            messages.push(json!({"role":"tool","content":results}));
        }
        let mut messages = Self::materialize_search_history(messages);
        // Provider item IDs and signed reasoning belong to the previous model
        // connection. Keep materialized text/tools so switching connections or
        // providers cannot reuse an inaccessible item or invalid signature.
        for message in &mut messages {
            if let Some(object) = message.as_object_mut() {
                object.remove("providerOptions");
            }
            if message["role"] == "assistant"
                && let Some(parts) = message["content"].as_array_mut()
            {
                parts.retain(|part| part["type"] != "reasoning");
                for part in parts {
                    if let Some(object) = part.as_object_mut() {
                        object.remove("providerOptions");
                    }
                }
            }
        }
        messages.retain(|message| {
            message["role"] != "assistant"
                || message["content"].as_array().is_none_or(|v| !v.is_empty())
        });
        messages
    }
    pub(crate) fn inherit_context(&mut self, parent: &Self) {
        self.workspace = parent.workspace.clone();
        self.files = parent.files.clone();
        self.todos = parent.todos.clone();
        self.budget = super::budget::Budget {
            prior: parent.total_usage().expect("validated parent usage"),
            granted: parent.budget.granted,
            pending: None,
        };
    }
    pub(crate) fn resolve(
        &self,
        channel: &Channel,
        request: &str,
        decision: Decision,
    ) -> Result<Option<Self>> {
        self.validate(channel)?;
        if let Some(recorded) = self.decision(request) {
            return if recorded == decision {
                Ok(None)
            } else {
                Err(Error(
                    "The approval response conflicts with the recorded decision.",
                ))
            };
        }
        if self.pending_request() != Some(request) {
            return Err(Error(
                "The approval response is stale or belongs to another request.",
            ));
        }
        if self.decisions.len() >= 4096 {
            return Err(Error("The agent approval history exceeds its size limit."));
        }
        let mut next = self.clone();
        next.revision = next.revision.checked_add(1).ok_or(INVALID)?;
        next.decisions.insert(request.to_owned(), decision);
        if let Some(pending) = &mut next.budget.pending {
            pending.decision = Some(decision);
            next.phase = Phase::Ready;
        } else {
            next.phase = Phase::Tools;
            let call = &mut next.calls[next.next_call];
            call.decision = Some(decision);
            call.phase = CallPhase::Queued;
        }
        next.validate(channel)?;
        if forge_core::canonical::javascript_stringify(&next.snapshot()).len() > 8 * 1024 * 1024 {
            return Err(INVALID);
        }
        Ok(Some(next))
    }
    pub fn decision(&self, request: &str) -> Option<Decision> {
        self.decisions.get(request).copied()
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
        if let Some(pending) = &self.budget.pending {
            return Some(&pending.request_id);
        }
        self.calls.get(self.next_call)?.request_id.as_deref()
    }
    pub(crate) fn validate(&self, channel: &Channel) -> Result<()> {
        let b = &self.binding;
        if b.user != channel.principal_id()
            || b.workspace != channel.workspace_id()
            || b.run != channel.run_id()
            || b.provider != channel.provider()
            || b.model != channel.model_id()
        {
            return Err(INVALID);
        }
        self.validate_structure()
    }
    fn validate_structure(&self) -> Result<()> {
        self.validate_budget()?;
        if self.compaction.last_input_tokens.is_some()
            != self.compaction.last_prompt_messages.is_some()
            || self
                .compaction
                .last_input_tokens
                .is_some_and(|n| n > 9_007_199_254_740_991)
            || self
                .compaction
                .last_prompt_messages
                .is_some_and(|n| n > 10000)
            || self.compaction.active.is_some() != (self.phase == Phase::Compacting)
            || self.compaction.active.is_some_and(|c| !c.is_valid())
            || self.phase == Phase::Compacting && (!self.calls.is_empty() || self.next_call != 0)
        {
            return Err(INVALID);
        }
        forge_core::agents::context::items(json!(self.todos)).map_err(|_| INVALID)?;
        if self.workspace.as_ref().is_none_or(|w| !w.provisioned) && !self.files.is_empty() {
            return Err(INVALID);
        }
        if self.workspace.as_ref().is_some_and(|w| w.key.is_nil()) {
            return Err(INVALID);
        }
        self.files
            .validate(self.workspace.as_ref().map(|w| w.identity()).as_deref())
            .map_err(|_| INVALID)?;
        if self.decisions.len() > 4096
            || self
                .decisions
                .keys()
                .any(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(INVALID);
        }
        let b = &self.binding;
        if self.version != 1
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
        request::build_for(
            &b.provider,
            &b.model,
            &crate::context::model_messages(&self.messages),
            &[],
            None,
        )
        .map_err(|_| INVALID)?;
        if self.phase == Phase::Waiting
            && self.budget.pending.is_none()
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
                    .or_else(|_| forge_core::agents::framework::input(&c.name, c.input.clone()))
                    .or_else(|_| forge_core::agents::context::input(&c.name, c.input.clone()))
                    .or_else(|_| forge_core::agents::web::input(&c.name, c.input.clone()))
                    .map_err(|_| INVALID)?;
                if input != c.input || forge_core::agents::approval::input_hash(&input) != *hash {
                    return Err(INVALID);
                }
            }
        }
        Ok(())
    }
}
