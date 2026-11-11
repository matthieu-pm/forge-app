use super::{
    Decision, Journal, Phase, State,
    state::{Call, CallPhase, INVALID},
};
use crate::{
    Error, Result,
    auth::Channel,
    model::{
        stream::{Completion, Delta, Finish},
        transport::{Model, Purpose, Sink, Turn},
    },
    sandbox::{Cancellation, Sandbox},
    tools::{Approval, Executor, Outcome},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::time::{Instant, timeout_at};
use uuid::Uuid;

pub struct Engine {
    pub model: Arc<dyn Model>,
    pub executor: Arc<Executor>,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub workspace_factory: Option<Arc<dyn crate::workspace::Factory>>,
    pub compaction: crate::context::Config,
    pub web: Arc<crate::web::Executor>,
}
impl Engine {
    pub fn new(model: Arc<dyn Model>, executor: Arc<Executor>) -> Self {
        Self {
            model,
            executor,
            max_input_tokens: 200_000,
            max_output_tokens: 50_000,
            workspace_factory: None,
            compaction: crate::context::Config::default(),
            web: Arc::new(crate::web::Executor::default()),
        }
    }
    pub(super) async fn commit(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        mut next: State,
        events: Vec<Value>,
    ) -> Result<()> {
        next.revision = state.revision.checked_add(1).ok_or(INVALID)?;
        if forge_core::canonical::javascript_stringify(&next.snapshot()).len() > 8 * 1024 * 1024 {
            return Err(Error("The agent continuation exceeds its size limit."));
        }
        journal.commit(state.revision, &next, &events).await?;
        *state = next;
        Ok(())
    }
    /// Resolves the currently parked request. The trusted owner has already
    /// resolved Forge's approval ledger; the gateway independently enforces it.
    pub async fn resume(
        &self,
        channel: &Channel,
        state: &mut State,
        journal: &dyn Journal,
        request: &str,
        decision: Decision,
    ) -> Result<()> {
        if let Some(next) = state.resolve(channel, request, decision)? {
            journal.commit(state.revision(), &next, &[]).await?;
            *state = next;
        }
        Ok(())
    }

    /// `deadline` is the original persisted run deadline converted to monotonic
    /// time by the owner, including after approval pauses and process restarts.
    pub async fn drive(
        &self,
        channel: &Channel,
        state: &mut State,
        journal: &dyn Journal,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Phase> {
        state.validate(channel)?;
        if self.max_input_tokens == 0
            || self.max_output_tokens == 0
            || self.max_input_tokens > 9_007_199_254_740_991
            || self.max_output_tokens > 9_007_199_254_740_991
            || !self.compaction.is_valid()
        {
            return Err(INVALID);
        }
        if cancellation.is_cancelled() {
            return Err(Error("Agent execution cancelled."));
        }
        if Instant::now() >= deadline {
            return Err(Error("Agent execution timed out."));
        }
        let result = tokio::select! {
            biased;
            ()=cancellation.cancelled()=>Err(Error("Agent execution cancelled.")),
            result=timeout_at(deadline,self.drive_inner(channel,state,journal,cancellation,deadline))=>result.map_err(|_|Error("Agent execution timed out."))?,
        }?;
        if cancellation.is_cancelled() {
            return Err(Error("Agent execution cancelled."));
        }
        if Instant::now() >= deadline {
            return Err(Error("Agent execution timed out."));
        }
        Ok(result)
    }
    pub(super) async fn fail(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        message: &'static str,
    ) -> Result<Phase> {
        let mut next = state.clone();
        next.phase = Phase::Failed;
        next.compaction.active = None;
        next.budget.pending = None;
        self.commit(
            state,
            journal,
            next,
            vec![event(
                state,
                "turn.failed",
                json!({"code":"RUNTIME_EXECUTION_FAILED","message":message}),
            )],
        )
        .await?;
        Err(Error(message))
    }
    async fn drive_inner(
        &self,
        channel: &Channel,
        state: &mut State,
        journal: &dyn Journal,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Phase> {
        let mut workspace = None;
        loop {
            if state
                .budget
                .pending
                .as_ref()
                .is_some_and(|p| p.decision.is_some())
            {
                self.apply_budget_decision(state, journal).await?;
                continue;
            }
            match state.phase {
                Phase::Complete | Phase::Cancelled | Phase::Waiting => return Ok(state.phase),
                Phase::Failed => return Err(Error("The agent turn has already failed.")),
                Phase::Compacting => {
                    self.compact(channel, state, journal, cancellation, deadline)
                        .await?;
                }
                Phase::Ready | Phase::Generating => {
                    if self.check_budget(state, journal).await? {
                        return Ok(Phase::Waiting);
                    }
                    if state.phase == Phase::Ready
                        && crate::context::should_compact(
                            &state.messages[1..],
                            self.compaction,
                            state.compaction.last_input_tokens.map(|n| n as f64),
                            state.compaction.last_prompt_messages.map(|n| n as f64),
                        )
                    {
                        let mut next = state.clone();
                        next.phase = Phase::Compacting;
                        next.compaction.active = Some(self.compaction);
                        let mut events = vec![];
                        if state.step == 0 {
                            events.push(event(state, "turn.started", json!({})));
                        }
                        events.push(event(state,"compaction.requested",json!({"modelId":channel.model_id(),"usageInputTokens":crate::context::input_count(&state.messages[1..],state.compaction.last_input_tokens.map(|n|n as f64),state.compaction.last_prompt_messages.map(|n|n as f64))})));
                        self.commit(state, journal, next, events).await?;
                        continue;
                    }
                    let mut events = vec![];
                    if state.phase == Phase::Ready && state.step == 0 {
                        events.push(event(state, "turn.started", json!({})));
                    }
                    events.push(event(state, "step.started", json!({})));
                    let mut next = state.clone();
                    next.phase = Phase::Generating;
                    // A retry gets a new revision before contacting a model. An
                    // older worker can neither append output nor settle this step.
                    self.commit(state, journal, next, events).await?;
                    let mut definitions=forge_core::agents::tools::descriptors().iter().map(|v|json!({"type":"function","name":v["name"],"description":v["description"],"inputSchema":v["inputSchema"]})).collect::<Vec<_>>();
                    definitions.extend(forge_core::agents::context::descriptors().iter().map(|v|json!({"type":"function","name":v["name"],"description":v["description"],"inputSchema":v["inputSchema"]})));
                    definitions.extend(forge_core::agents::web::descriptors().iter().map(|v|json!({"type":"function","name":v["name"],"description":v["description"],"inputSchema":v["inputSchema"]})));
                    if let Some(search) = crate::model::search::descriptor(
                        crate::model::request::Protocol::for_provider(channel.provider()),
                    ) {
                        definitions.push(search);
                    }
                    if self.workspace_factory.is_some() {
                        definitions.extend(forge_core::agents::framework::descriptors().iter().map(|v|json!({"type":"function","name":v["name"],"description":v["description"],"inputSchema":v["inputSchema"]})));
                    }
                    let max = self.remaining_output(state)?;
                    let mut sink = Progress { journal, state };
                    let prompt = crate::context::model_messages(&state.messages);
                    let completion = self
                        .model
                        .generate(
                            channel,
                            Turn {
                                prompt: &prompt,
                                tools: &definitions,
                                max_output_tokens: Some(max),
                                deadline,
                                purpose: Purpose::Response,
                            },
                            cancellation,
                            &mut sink,
                        )
                        .await;
                    let completion = match completion {
                        Ok(value) => value,
                        Err(_) => {
                            return self
                                .fail(state, journal, "The model could not complete this step.")
                                .await;
                        }
                    };
                    self.settle_model(channel, state, journal, completion)
                        .await?;
                }
                Phase::Tools => {
                    if state.next_call == state.calls.len() {
                        let results=state.calls.iter().map(|c|json!({"type":"tool-result","toolCallId":c.id,"toolName":c.name,"output":c.output})).collect::<Vec<_>>();
                        let mut next = state.clone();
                        next.messages.push(json!({"role":"tool","content":results}));
                        next.calls.clear();
                        next.next_call = 0;
                        next.step = next.step.checked_add(1).ok_or(INVALID)?;
                        next.phase = Phase::Ready;
                        self.commit(state, journal, next, vec![]).await?;
                        continue;
                    }
                    let call = state.calls[state.next_call].clone();
                    if call.phase == CallPhase::Complete {
                        return Err(INVALID);
                    }
                    if call.phase == CallPhase::Calling
                        && !matches!(
                            call.name.as_str(),
                            "list_teams"
                                | "get_team"
                                | "describe_workspace"
                                | "update_team"
                                | "read_file"
                                | "glob"
                                | "grep"
                                | "todo"
                                | "web_fetch"
                        )
                    {
                        return self.fail(state,journal,"An interrupted tool requires reconciliation before it can run again.").await;
                    }
                    if call.name == "todo" {
                        self.execute_todo(state, journal).await?;
                        continue;
                    }
                    if call.name == "web_fetch" {
                        self.execute_web(state, journal, cancellation).await?;
                        continue;
                    }
                    if super::workspace::is_framework(&call.name)
                        && self.workspace_factory.is_some()
                    {
                        self.execute_framework(state, journal, cancellation, &mut workspace)
                            .await?;
                        continue;
                    }
                    let prepared = match self.prepare_authored(&call.name, call.input.clone()) {
                        Ok(value) => value,
                        Err(error) => {
                            self.settle_tool(
                                state,
                                journal,
                                json!({"type":"error-text","value":error.to_string()}),
                                "failed",
                            )
                            .await?;
                            continue;
                        }
                    };
                    if call.input_hash.as_deref() != Some(prepared.input_hash()) {
                        return Err(INVALID);
                    }
                    if prepared.requires_approval() && call.decision.is_none() {
                        let mut next = state.clone();
                        next.phase = Phase::Waiting;
                        let pending = &mut next.calls[next.next_call];
                        pending.phase = CallPhase::Waiting;
                        let request = pending
                            .request_id
                            .get_or_insert_with(|| Uuid::new_v4().to_string())
                            .clone();
                        let prompt = if call.name == "update_team" {
                            "Allow this team settings change?"
                        } else {
                            "Allow this program's declared Forge writes?"
                        };
                        let request = json!({"requestId":request,"kind":"tool-approval","display":"confirmation","prompt":prompt,"allowFreeform":false,"options":[{"id":"approve","label":"Approve"},{"id":"deny","label":"Deny"}],"action":{"callId":call.id,"kind":"tool-call","toolName":call.name,"input":call.input}});
                        let events = vec![
                            event(state, "input.requested", json!({"requests":[request]})),
                            event(state, "session.waiting", json!({"reason":"input-required"})),
                        ];
                        self.commit(state, journal, next, events).await?;
                        return Ok(Phase::Waiting);
                    }
                    let approval = match call.decision {
                        Some(decision) => Approval::Resolved {
                            run_id: channel.run_id().into(),
                            tool_name: call.name.clone(),
                            input_hash: prepared.input_hash().into(),
                            approved: decision == Decision::Approved,
                        },
                        None => Approval::Pending,
                    };
                    let isolated = if self.workspace_factory.is_some()
                        && matches!(call.name.as_str(), "run_code" | "execute_program")
                        && call.decision != Some(Decision::Denied)
                    {
                        Some(
                            self.ensure_workspace(state, journal, &mut workspace)
                                .await?
                                .sandbox
                                .clone() as Arc<dyn Sandbox>,
                        )
                    } else {
                        None
                    };
                    let executor = isolated.map(|sandbox| Executor {
                        capabilities: self.executor.capabilities.clone(),
                        sandbox: Some(sandbox),
                        features: self.executor.features,
                    });
                    let executor = executor.as_ref().unwrap_or(self.executor.as_ref());
                    let mut next = state.clone();
                    next.calls[next.next_call].phase = CallPhase::Calling;
                    // A committed dispatch reservation precedes every external
                    // effect. Ambiguous reservations must be reloaded by the owner.
                    self.commit(state, journal, next, vec![]).await?;
                    match executor.execute(channel,prepared,approval,cancellation).await {
                        Ok(Outcome::Completed(output))=>self.settle_tool(state,journal,json!({"type":"json","value":output}),"completed").await?,
                        Ok(Outcome::Denied)=>self.settle_tool(state,journal,json!({"type":"execution-denied","reason":"The user denied this action."}),"rejected").await?,
                        Ok(Outcome::ApprovalRequired(_))=>return Err(INVALID),
                        Err(error)=>self.settle_tool(state,journal,json!({"type":"error-text","value":error.to_string()}),"failed").await?,
                    }
                }
            }
        }
    }
    async fn settle_model(
        &self,
        channel: &Channel,
        state: &mut State,
        journal: &dyn Journal,
        completion: Completion,
    ) -> Result<()> {
        let mut next = state.clone();
        next.compaction.last_input_tokens = completion.usage["inputTokens"].as_u64();
        next.compaction.last_prompt_messages = next
            .compaction
            .last_input_tokens
            .map(|_| state.messages.len() - 1);
        let mut actions = vec![];
        let mut message = String::new();
        let mut content = completion.content;
        let searches = super::search::inspect(
            &content,
            crate::model::request::Protocol::for_provider(channel.provider()),
        )?;
        let may_call = matches!(completion.finish, Finish::Stop | Finish::ToolCalls);
        let mut ids = std::collections::HashSet::new();
        for part in &mut content {
            match part["type"].as_str() {
                Some("text") => message.push_str(part["text"].as_str().ok_or(INVALID)?),
                Some("reasoning" | "tool-result") => {}
                Some("tool-call") if part["providerExecuted"] == true => {}
                Some("tool-call") if may_call => {
                    let id = part["toolCallId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or(INVALID)?
                        .to_owned();
                    let name = part["toolName"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or(INVALID)?
                        .to_owned();
                    if !part["input"].is_object() || !ids.insert(id.clone()) || ids.len() > 128 {
                        return Err(INVALID);
                    }
                    let hash = if let Ok(input) = self.prepare_input(&name, part["input"].clone()) {
                        part["input"] = input;
                        Some(forge_core::agents::approval::input_hash(&part["input"]))
                    } else {
                        None
                    };
                    actions.push(json!({"callId":id,"kind":"tool-call","toolName":name,"input":part["input"]}));
                    next.calls.push(Call {
                        id,
                        name,
                        input: part["input"].clone(),
                        input_hash: hash,
                        phase: CallPhase::Queued,
                        request_id: None,
                        decision: None,
                        output: None,
                    });
                }
                Some("tool-call") => {}
                _ => return Err(INVALID),
            }
        }
        if !may_call {
            content.retain(|p| p["type"] != "tool-call" || p["providerExecuted"] == true);
        }
        next.messages
            .push(json!({"role":"assistant","content":content}));
        for (key, target) in [
            ("inputTokens", &mut next.input_tokens),
            ("outputTokens", &mut next.output_tokens),
        ] {
            if !completion.usage[key].is_null() {
                let count = completion.usage[key].as_u64().ok_or(INVALID)?;
                *target = target
                    .checked_add(count)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(INVALID)?;
            }
        }
        let usage = completion
            .usage
            .as_object()
            .ok_or(INVALID)?
            .iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<serde_json::Map<_, _>>();
        let mut events = vec![];
        if !searches.actions.is_empty() {
            events.push(event(
                state,
                "actions.requested",
                json!({"actions":searches.actions}),
            ));
            for result in searches.results {
                let failed = result["output"]["type"] == "error-json";
                events.push(event(
                    state,
                    "action.result",
                    json!({"result":result,"status":if failed{"failed"}else{"completed"}}),
                ));
            }
        }
        if !message.is_empty() {
            events.push(event(
                state,
                "message.completed",
                json!({"message":message,"finishReason":completion.finish.as_str(),"sources":searches.sources}),
            ));
        }
        events.push(event(
            state,
            "step.completed",
            json!({"finishReason":completion.finish.as_str(),"usage":usage}),
        ));
        if next.calls.is_empty() && may_call && searches.continue_model {
            next.step = next.step.checked_add(1).ok_or(INVALID)?;
            next.phase = Phase::Ready;
        } else if next.calls.is_empty() {
            next.phase = Phase::Complete;
            events.push(event(state, "turn.completed", json!({})));
            events.push(event(state, "session.waiting", json!({})));
        } else {
            next.phase = Phase::Tools;
            events.push(event(
                state,
                "actions.requested",
                json!({"actions":actions}),
            ));
        }
        next.validate(channel)?;
        self.commit(state, journal, next, events).await
    }
    pub(super) async fn settle_tool(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        output: Value,
        status: &str,
    ) -> Result<()> {
        self.settle_tool_with_files(state, journal, output, status, None)
            .await
    }
    pub(super) async fn settle_tool_with_files(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        output: Value,
        status: &str,
        files: Option<crate::framework::FileState>,
    ) -> Result<()> {
        let mut next = state.clone();
        if let Some(files) = files {
            next.files = files;
        }
        self.settle_tool_state(state, journal, next, output, status)
            .await
    }
    async fn execute_todo(&self, state: &mut State, journal: &dyn Journal) -> Result<()> {
        let call = &state.calls[state.next_call];
        let input = match self.prepare_input(&call.name, call.input.clone()) {
            Ok(input) => input,
            Err(error) => {
                return self
                    .settle_tool(
                        state,
                        journal,
                        json!({"type":"error-text","value":error.to_string()}),
                        "failed",
                    )
                    .await;
            }
        };
        if call.input_hash.as_deref() != Some(&forge_core::agents::approval::input_hash(&input))
            || call.request_id.is_some()
            || call.decision.is_some()
        {
            return Err(INVALID);
        }
        let mut next = state.clone();
        if let Some(todos) = input["todos"].as_array() {
            next.todos = todos.clone();
        }
        let output = forge_core::agents::context::output(&next.todos);
        // The task list and receipt are one local transaction: no external
        // dispatch reservation or resource allocation is required.
        self.settle_tool_state(
            state,
            journal,
            next,
            json!({"type":"json","value":output}),
            "completed",
        )
        .await
    }
    async fn settle_tool_state(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        mut next: State,
        output: Value,
        status: &str,
    ) -> Result<()> {
        let call = &state.calls[state.next_call];
        let result =
            json!({"callId":call.id,"kind":"tool-call","toolName":call.name,"output":output});
        let call = &mut next.calls[next.next_call];
        call.phase = CallPhase::Complete;
        call.output = Some(output);
        next.next_call += 1;
        self.commit(
            state,
            journal,
            next,
            vec![event(
                state,
                "action.result",
                json!({"result":result,"status":status}),
            )],
        )
        .await
    }
}
pub(super) fn event(state: &State, kind: &str, mut data: Value) -> Value {
    data["turnId"] = json!(state.run_id());
    data["stepIndex"] = json!(state.step);
    json!({"type":kind,"data":data})
}
struct Progress<'a> {
    journal: &'a dyn Journal,
    state: &'a State,
}
#[async_trait]
impl Sink for Progress<'_> {
    async fn emit(&mut self, delta: Delta) -> Result<()> {
        let (kind, key, text) = match delta {
            Delta::Text { text, .. } => ("message.appended", "messageDelta", text),
            Delta::Reasoning { text, .. } => ("reasoning.appended", "reasoningDelta", text),
            Delta::ToolInput { .. } => return Ok(()),
        };
        // Keep normalized public deltas below the app event bound, preserving
        // Unicode boundaries. Complete tool input is published after checkpoint.
        let mut remaining = text.as_str();
        while !remaining.is_empty() {
            let mut size = remaining.len().min(16 * 1024);
            while !remaining.is_char_boundary(size) {
                size -= 1;
            }
            let mut data = json!({});
            data[key] = json!(&remaining[..size]);
            self.journal
                .append(self.state.revision, event(self.state, kind, data))
                .await?;
            remaining = &remaining[size..];
        }
        Ok(())
    }
}
