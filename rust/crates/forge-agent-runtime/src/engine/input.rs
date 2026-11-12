//! Ordinary question batches. Required mixed-input deferral remains a separate
//! gate: collecting questions never authorizes or executes another tool call.
use super::{
    Engine, Journal, Phase, State,
    state::{CallPhase, INVALID},
    turn::event,
};
use crate::{Error, Result, auth::Channel};
use forge_core::agents::input as contract;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

const STALE: Error = Error("The question response is stale or conflicts with its recorded answer.");

impl State {
    pub fn pending_questions(&self) -> Vec<Value> {
        self.questions.clone()
    }

    pub(super) fn validate_questions(&self) -> Result<()> {
        if self.questions.len() > 128 || self.question_answers.len() > 4096 {
            return Err(INVALID);
        }
        for (id, answer) in &self.question_answers {
            if id.is_empty() || id.len() > 1024 || contract::output(answer.clone()).is_err() {
                return Err(INVALID);
            }
        }
        if let Some(message) = &self.question_followup
            && (message["role"] != "user"
                || message
                    .as_object()
                    .is_none_or(|o| o.len() != 2 || !o.contains_key("content"))
                || self.calls.is_empty())
        {
            return Err(INVALID);
        }
        if !self.questions.is_empty()
            && (self.phase != Phase::Waiting || self.budget.pending.is_some())
        {
            return Err(INVALID);
        }
        let mut ids = HashSet::new();
        for request in &self.questions {
            let id = request["requestId"].as_str().ok_or(INVALID)?;
            let call = self
                .calls
                .iter()
                .find(|call| call.id == id)
                .ok_or(INVALID)?;
            if !ids.insert(id)
                || call.name != "ask_question"
                || call.phase != CallPhase::Waiting
                || call.request_id.as_deref() != Some(id)
                || call.decision.is_some()
                || call.output.is_some()
                || call.input_hash.is_none()
                || contract::question(id, &call.input) != *request
                || self.question_answers.contains_key(id)
            {
                return Err(INVALID);
            }
        }
        if !self.questions.is_empty()
            && (self
                .calls
                .get(self.next_call)
                .is_none_or(|call| !ids.contains(call.id.as_str()))
                || self.calls.iter().any(|call| {
                    call.phase == CallPhase::Calling
                        || call.phase == CallPhase::Waiting && !ids.contains(call.id.as_str())
                }))
        {
            return Err(INVALID);
        }
        for call in self.calls.iter().filter(|call| call.name == "ask_question") {
            if call.decision.is_some()
                || call.phase == CallPhase::Calling
                || call.phase == CallPhase::Waiting && !ids.contains(call.id.as_str())
            {
                return Err(INVALID);
            }
            if let Some(request) = &call.request_id {
                if request != &call.id
                    || !matches!(call.phase, CallPhase::Waiting | CallPhase::Complete)
                {
                    return Err(INVALID);
                }
                if call.phase == CallPhase::Complete
                    && (call
                        .output
                        .as_ref()
                        .is_none_or(|output| output["type"] != "json")
                        || self.question_answers.get(request)
                            != call.output.as_ref().and_then(|output| output.get("value")))
                {
                    return Err(INVALID);
                }
            }
        }
        Ok(())
    }

    /// Typed responses are independent of approval decisions. One supplied
    /// response resolves the ordinary batch; missing responses become ignored.
    pub(crate) fn resolve_questions(
        &self,
        channel: &Channel,
        responses: &[Value],
    ) -> Result<Option<(Self, Vec<Value>)>> {
        self.validate(channel)?;
        if responses.is_empty() || responses.len() > 128 {
            return Err(STALE);
        }
        let responses = typed_responses(responses)?;
        if self.questions.is_empty() {
            if responses.iter().all(|(id, response)| {
                self.question_answers.get(id) == Some(&contract::question_output(Some(response)))
            }) {
                return Ok(None);
            }
            return Err(STALE);
        }
        if responses
            .keys()
            .any(|id| !self.questions.iter().any(|q| q["requestId"] == *id))
        {
            return Err(STALE);
        }
        let mut next = self.clone();
        let events = next.answer_questions(&responses)?;
        next.revision = self.revision.checked_add(1).ok_or(INVALID)?;
        next.validate(channel)?;
        bounded(&next)?;
        Ok(Some((next, events)))
    }

    fn answer_questions(&mut self, responses: &BTreeMap<String, Value>) -> Result<Vec<Value>> {
        if self.question_answers.len() + self.questions.len() > 4096 {
            return Err(Error("The agent question history exceeds its size limit."));
        }
        let mut events = vec![];
        for request in std::mem::take(&mut self.questions) {
            let id = request["requestId"].as_str().ok_or(INVALID)?;
            let answer = contract::question_output(responses.get(id));
            let call = self
                .calls
                .iter_mut()
                .find(|call| call.id == id)
                .ok_or(INVALID)?;
            let output = json!({"type":"json","value":answer});
            call.output = Some(output.clone());
            call.phase = CallPhase::Complete;
            self.question_answers.insert(id.to_owned(), answer);
            let result =
                json!({"callId":call.id,"kind":"tool-call","toolName":call.name,"output":output});
            events.push(event(
                self,
                "action.result",
                json!({"result":result,"status":"completed"}),
            ));
        }
        self.phase = Phase::Tools;
        Ok(events)
    }

    /// The journal owns the conversation-head lock and old-run fence. This
    /// creates only the successor snapshot/events; it performs no tool effects.
    pub fn question_continuation(
        &self,
        channel: &Channel,
        message: Value,
        cancelled: bool,
    ) -> Result<Option<(Self, Vec<Value>)>> {
        self.validate_structure()?;
        if self.questions.is_empty() {
            return Ok(None);
        }
        if self.binding.user != channel.principal_id()
            || self.binding.workspace != channel.workspace_id()
            || self.binding.run == channel.run_id()
            || self.question_followup.is_some()
            || message["role"] != "user"
            || message
                .as_object()
                .is_none_or(|o| o.len() != 2 || !o.contains_key("content"))
        {
            return Err(INVALID);
        }
        // Validate the complete user content before any text is consumed.
        State::new(channel, vec![message.clone()])?;
        let text = match &message["content"] {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return Err(INVALID),
        };
        let responses = contract::resolve_text(&text, &self.questions);
        let consumed = !responses.is_empty();
        let responses = typed_responses(&responses)?;
        let history = Self::transfer_history(self.messages.iter().skip(1).cloned().collect());
        let mut next = State::new(channel, history)?;
        next.inherit_context(self);
        next.calls = self.calls.clone();
        next.next_call = self.next_call;
        next.questions = self.questions.clone();
        // Receipts for completed calls are required to preserve their exact
        // model results across a question pause and a model connection change.
        next.question_answers = self.question_answers.clone();
        let mut events = next.answer_questions(&responses)?;
        if cancelled {
            for index in 0..next.calls.len() {
                if next.calls[index].phase == CallPhase::Complete {
                    continue;
                }
                let call = &mut next.calls[index];
                let output = json!({"type":"execution-denied","reason":"The previous run ended before this tool was executed."});
                call.phase = CallPhase::Complete;
                call.output = Some(output.clone());
                let result = json!({"callId":call.id,"kind":"tool-call","toolName":call.name,"output":output});
                events.push(event(
                    &next,
                    "action.result",
                    json!({"result":result,"status":"rejected"}),
                ));
            }
        }
        next.question_followup = remaining_message(message, consumed);
        if next
            .calls
            .iter()
            .all(|call| call.phase == CallPhase::Complete)
        {
            let results = next.calls.iter().map(|call| json!({"type":"tool-result","toolCallId":call.id,"toolName":call.name,"output":call.output})).collect::<Vec<_>>();
            next.messages.push(json!({"role":"tool","content":results}));
            if let Some(message) = next.question_followup.take() {
                next.messages.push(message);
            }
            next.calls.clear();
            next.next_call = 0;
            next.phase = Phase::Ready;
        } else {
            // The queued tail runs before Ready advances to step 1, so this
            // successor does not pass the usual Ready(step == 0) preamble.
            events.insert(0, event(&next, "turn.started", json!({})));
        }
        // Admission starts a new run/revision, even when its first work is the
        // unexecuted tail of the previous model's tool batch.
        next.revision = 0;
        next.validate(channel)?;
        bounded(&next)?;
        Ok(Some((next, events)))
    }
}

fn remaining_message(mut message: Value, consumed: bool) -> Option<Value> {
    if !consumed {
        return Some(message);
    }
    let parts = message["content"].as_array_mut()?;
    parts.retain(|part| part["type"] != "text");
    if parts.is_empty() {
        None
    } else {
        Some(message)
    }
}

fn typed_responses(responses: &[Value]) -> Result<BTreeMap<String, Value>> {
    let mut result = BTreeMap::new();
    for response in responses {
        let response = contract::response(response.clone()).map_err(|_| STALE)?;
        let id = response["requestId"].as_str().ok_or(STALE)?.to_owned();
        // The owning source builds a Map: a later duplicate request wins.
        result.insert(id, response);
    }
    Ok(result)
}

fn bounded(state: &State) -> Result<()> {
    if forge_core::canonical::javascript_stringify(&state.snapshot()).len() > 8 * 1024 * 1024 {
        return Err(INVALID);
    }
    Ok(())
}

impl Engine {
    pub async fn resume_questions(
        &self,
        channel: &Channel,
        state: &mut State,
        journal: &dyn Journal,
        responses: &[Value],
    ) -> Result<()> {
        if let Some((next, events)) = state.resolve_questions(channel, responses)? {
            journal.commit(state.revision(), &next, &events).await?;
            *state = next;
        }
        Ok(())
    }

    pub(super) async fn collect_questions(
        &self,
        state: &mut State,
        journal: &dyn Journal,
    ) -> Result<bool> {
        let call = &state.calls[state.next_call];
        if let Err(error) = self.prepare_input(&call.name, call.input.clone()) {
            self.settle_tool(
                state,
                journal,
                json!({"type":"error-text","value":error.to_string()}),
                "failed",
            )
            .await?;
            return Ok(false);
        }
        let mut next = state.clone();
        for call in next.calls.iter_mut().skip(next.next_call) {
            if call.name != "ask_question" || call.phase != CallPhase::Queued {
                continue;
            }
            let Ok(input) = self.prepare_input(&call.name, call.input.clone()) else {
                continue;
            };
            if call.input_hash.as_deref() != Some(&forge_core::agents::approval::input_hash(&input))
                || call.request_id.is_some()
                || call.decision.is_some()
            {
                return Err(INVALID);
            }
            call.phase = CallPhase::Waiting;
            call.request_id = Some(call.id.clone());
            // Tool-call IDs are unique within a model batch, not across the
            // conversation. The old result remains in history; a new question
            // with that ID replaces its typed replay receipt, never an approval.
            next.question_answers.remove(&call.id);
            next.questions.push(contract::question(&call.id, &input));
        }
        if next.questions.is_empty() {
            return Err(INVALID);
        }
        next.phase = Phase::Waiting;
        let events = vec![
            event(state, "input.requested", json!({"requests":next.questions})),
            event(state, "session.waiting", json!({"reason":"input-required"})),
        ];
        next.validate_questions()?;
        self.commit(state, journal, next, events).await?;
        Ok(true)
    }
}
