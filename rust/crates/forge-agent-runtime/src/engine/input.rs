//! A delivery can finish while a model-owned input batch remains pending.
//! Typed decisions never replace the application's run-bound capability ledger.
use super::{
    Decision, Engine, Journal, Phase, State,
    state::{Call, CallPhase, INVALID},
    turn::event,
};
use crate::{Error, Result, auth::Channel};
use forge_core::agents::{input as contract, pending_input as pending};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

const STALE: Error = Error("The input response is stale or conflicts with its recorded answer.");

// Both snapshots are installed by one journal transaction; keep ownership explicit.
#[allow(clippy::large_enum_variant)]
pub enum InputDelivery {
    Deferred {
        owner: State,
        delivery: State,
        events: Vec<Value>,
    },
    Resolved {
        state: State,
        events: Vec<Value>,
    },
}

impl State {
    pub fn pending_questions(&self) -> Vec<Value> {
        self.questions.clone()
    }
    pub fn pending_requests(&self) -> Vec<Value> {
        self.pending_input
            .batch
            .as_ref()
            .map(|batch| batch.requests.clone())
            .unwrap_or_default()
    }
    pub fn has_required_input(&self) -> bool {
        self.pending_input
            .batch
            .as_ref()
            .is_some_and(|batch| batch.requests.iter().any(pending::is_required))
    }
    pub fn issued_request(&self, id: &str) -> Option<&Value> {
        self.issued_requests.get(id)
    }

    pub(super) fn migrate_input(&mut self) {
        let mut requests = self.questions.clone();
        if let Some(budget) = &self.budget.pending {
            let request = budget.request();
            self.issued_requests
                .insert(budget.request_id.clone(), request.clone());
            requests = if budget.decision.is_none() {
                vec![request]
            } else {
                vec![]
            };
        } else if requests.is_empty()
            && self.phase == Phase::Waiting
            && let Some(call) = self.calls.get(self.next_call)
            && call.phase == CallPhase::Waiting
            && call.request_id.is_some()
        {
            requests.push(approval_request(call));
        }
        if !requests.is_empty() {
            self.install_batch(requests);
        }
    }

    pub(super) fn install_batch(&mut self, requests: Vec<Value>) {
        for request in requests
            .iter()
            .filter(|request| request["kind"] == "tool-approval")
        {
            if let Some(parts) = self
                .messages
                .iter_mut()
                .rev()
                .filter(|message| message["role"] == "assistant")
                .filter_map(|message| message["content"].as_array_mut())
                .find(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "tool-call"
                            && part["toolCallId"] == request["action"]["callId"]
                    })
                })
                && !parts.iter().any(|part| {
                    part["type"] == "tool-approval-request"
                        && part["approvalId"] == request["requestId"]
                })
            {
                parts.push(json!({"type":"tool-approval-request","approvalId":request["requestId"],"toolCallId":request["action"]["callId"]}));
            }
        }
        for request in requests
            .iter()
            .filter(|request| pending::is_required(request))
        {
            self.issued_requests.insert(
                request["requestId"]
                    .as_str()
                    .expect("owned request ID")
                    .to_owned(),
                request.clone(),
            );
        }
        self.questions = requests
            .iter()
            .filter(|request| request["kind"] == "question")
            .cloned()
            .collect();
        self.pending_input.batch = Some(pending::PendingBatch {
            event: Some(event(self, "input.requested", json!({"requests":requests}))),
            requests,
            response_messages: vec![],
        });
    }

    pub(super) fn validate_questions(&self) -> Result<()> {
        if self.questions.len() > 128
            || self.question_answers.len() > 4096
            || self.issued_requests.len() > 4096
            || self.pending_input.approved_keys.len() > 4096
        {
            return Err(INVALID);
        }
        for (id, answer) in &self.question_answers {
            if id.is_empty() || id.len() > 1024 || contract::output(answer.clone()).is_err() {
                return Err(INVALID);
            }
        }
        for (id, request) in &self.issued_requests {
            if uuid::Uuid::parse_str(id).is_err()
                || request["requestId"] != *id
                || !pending::is_required(request)
            {
                return Err(INVALID);
            }
        }
        if let Some(message) = &self.question_followup {
            validate_message(message)?;
            if self.calls.is_empty() {
                return Err(INVALID);
            }
        }
        if let Some(input) = &self.pending_input.deferred_input {
            let object = input.as_object().ok_or(INVALID)?;
            if object.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "message" | "messageConsumed" | "inputResponses"
                )
            }) {
                return Err(INVALID);
            }
            if let Some(message) = input.get("message") {
                self.validate_content(message.clone())?;
            }
            if let Some(responses) = input.get("inputResponses") {
                typed_responses(responses.as_array().ok_or(INVALID)?)?;
            }
        }
        let mut ids = HashSet::new();
        let mut question_ids = HashSet::new();
        if let Some(batch) = &self.pending_input.batch {
            if batch.requests.is_empty()
                || batch.requests.len() > 128
                || !batch.response_messages.is_empty()
                || !matches!(self.phase, Phase::Waiting | Phase::Complete)
            {
                return Err(INVALID);
            }
            for request in &batch.requests {
                let id = request["requestId"].as_str().ok_or(INVALID)?;
                if !ids.insert(id) {
                    return Err(INVALID);
                }
                if request["kind"] == "session-limit" {
                    if batch.requests.len() != 1
                        || self
                            .budget
                            .pending
                            .as_ref()
                            .is_none_or(|budget| budget.request() != *request)
                    {
                        return Err(INVALID);
                    }
                    continue;
                }
                let call = self
                    .calls
                    .iter()
                    .find(|call| call.request_id.as_deref() == Some(id))
                    .ok_or(INVALID)?;
                if call.phase != CallPhase::Waiting
                    || call.decision.is_some()
                    || call.output.is_some()
                    || call.input_hash.is_none()
                {
                    return Err(INVALID);
                }
                if request["kind"] == "question" {
                    if call.name != "ask_question"
                        || id != call.id
                        || contract::question(id, &call.input) != *request
                        || self.question_answers.contains_key(id)
                    {
                        return Err(INVALID);
                    }
                    question_ids.insert(id);
                } else if request["kind"] != "tool-approval"
                    || uuid::Uuid::parse_str(id).is_err()
                    || approval_request(call) != *request
                {
                    return Err(INVALID);
                }
            }
        }
        if self.questions
            != self
                .pending_requests()
                .into_iter()
                .filter(|request| request["kind"] == "question")
                .collect::<Vec<_>>()
        {
            return Err(INVALID);
        }
        for call in &self.calls {
            if call.phase == CallPhase::Waiting
                && (call.request_id.is_none()
                    || call.input_hash.is_none()
                    || call.decision.is_some()
                    || call.output.is_some())
            {
                return Err(INVALID);
            }
            if call.phase == CallPhase::Waiting
                && self.pending_input.batch.is_none()
                && self.phase != Phase::Tools
            {
                return Err(INVALID);
            }
            if call.phase == CallPhase::Waiting
                && self.pending_input.batch.is_some()
                && !ids.contains(call.request_id.as_deref().ok_or(INVALID)?)
            {
                return Err(INVALID);
            }
            if call.name == "ask_question" {
                if call.decision.is_some() || call.phase == CallPhase::Calling {
                    return Err(INVALID);
                }
                if let Some(id) = &call.request_id {
                    if id != &call.id
                        || !matches!(call.phase, CallPhase::Waiting | CallPhase::Complete)
                    {
                        return Err(INVALID);
                    }
                    if call.phase == CallPhase::Complete
                        && (call
                            .output
                            .as_ref()
                            .is_none_or(|output| output["type"] != "json")
                            || self.question_answers.get(id)
                                != call.output.as_ref().and_then(|output| output.get("value")))
                    {
                        return Err(INVALID);
                    }
                    if call.phase == CallPhase::Waiting
                        && self.pending_input.batch.is_some()
                        && !question_ids.contains(id.as_str())
                    {
                        return Err(INVALID);
                    }
                }
            }
        }
        Ok(())
    }

    fn validate_content(&self, content: Value) -> Result<()> {
        let mut messages = self.messages.clone();
        messages.push(json!({"role":"user","content":content}));
        crate::model::request::build_for(
            &self.binding.provider,
            &self.binding.model,
            &crate::context::model_messages(&messages),
            &[],
            None,
        )
        .map_err(|_| INVALID)?;
        Ok(())
    }

    /// The caller has proven journal lineage and supplies the target run's own
    /// last snapshot. Session history and usage come exclusively from `self`.
    fn rebind(&self, channel: &Channel, original: Option<&State>) -> Result<State> {
        self.validate_structure()?;
        if self.binding.user != channel.principal_id()
            || self.binding.workspace != channel.workspace_id()
        {
            return Err(INVALID);
        }
        let mut next = self.clone();
        let history = Self::transfer_history(self.messages.iter().skip(1).cloned().collect());
        let fresh = State::new(channel, history)?;
        next.binding = fresh.binding;
        next.messages = fresh.messages;
        next.compaction.active = None;
        let total = self.total_usage()?;
        if let Some(original) = original {
            original.validate_structure()?;
            if original.binding.user != channel.principal_id()
                || original.binding.workspace != channel.workspace_id()
                || original.binding.run != channel.run_id()
            {
                return Err(INVALID);
            }
            next.input_tokens = original.input_tokens;
            next.output_tokens = original.output_tokens;
            next.decisions = original.decisions.clone();
            next.issued_requests = original.issued_requests.clone();
            next.revision = original.revision.checked_add(1).ok_or(INVALID)?;
        } else {
            next.input_tokens = 0;
            next.output_tokens = 0;
            next.step = 0;
            next.decisions.clear();
            next.issued_requests.clear();
            next.revision = 0;
        }
        next.budget.prior.input = total.input.checked_sub(next.input_tokens).ok_or(INVALID)?;
        next.budget.prior.output = total
            .output
            .checked_sub(next.output_tokens)
            .ok_or(INVALID)?;
        Ok(next)
    }

    pub fn compose_input(
        &self,
        channel: &Channel,
        message: Value,
        cancelled: bool,
    ) -> Result<Option<InputDelivery>> {
        self.validate_structure()?;
        validate_message(&message)?;
        State::new(channel, vec![message.clone()])?;
        if self.binding.run == channel.run_id() {
            return Err(INVALID);
        }
        if self.pending_input.batch.is_none() {
            return Ok(None);
        }
        if cancelled && self.has_required_input() {
            if self
                .pending_requests()
                .iter()
                .all(|request| request["kind"] == "session-limit")
            {
                // Source cancellation clears the limit prompt, not queued user
                // input. Consume that input with the next delivery, while the
                // unchanged session usage can still require a fresh limit prompt.
                let mut next = self.rebind(channel, None)?;
                next.pending_input = pending::clear_session_limit_prompt(&next.pending_input);
                next.budget.pending = None;
                let (_, events) = next.deliver_input(&json!({"message":message["content"]}))?;
                next.validate(channel)?;
                bounded(&next)?;
                return Ok(Some(InputDelivery::Resolved {
                    state: next,
                    events,
                }));
            }
            // A cancelled owner's writes cannot be revived by a new composer.
            // The journal starts clean through next_history's denial cleanup.
            return Ok(None);
        }
        let mut owner = self.clone();
        let input = json!({"message":message["content"]});
        let (resolved, _) = owner.deliver_input(&input)?;
        if !resolved {
            owner.phase = self.phase;
            owner.revision = self.revision.checked_add(1).ok_or(INVALID)?;
            owner.validate_structure()?;
            let history = Self::transfer_history(self.messages.iter().skip(1).cloned().collect());
            let mut delivery = State::new(channel, history)?;
            delivery.inherit_context(self);
            delivery.phase = Phase::Complete;
            let events = delivery_events(&delivery);
            bounded(&owner)?;
            return Ok(Some(InputDelivery::Deferred {
                owner,
                delivery,
                events,
            }));
        }
        let mut next = self.rebind(channel, None)?;
        let (_, mut events) = next.deliver_input(&input)?;
        if cancelled {
            for index in 0..next.calls.len() {
                if matches!(next.calls[index].phase, CallPhase::Complete)
                    || next.calls[index].decision.is_some()
                {
                    continue;
                }
                let call = &mut next.calls[index];
                call.phase = CallPhase::Complete;
                call.output = Some(
                    json!({"type":"execution-denied","reason":"The previous run ended before this tool was executed."}),
                );
                events.push(event(&next, "action.result", json!({"result":{"callId":next.calls[index].id,"kind":"tool-call","toolName":next.calls[index].name,"output":next.calls[index].output},"status":"rejected"})));
            }
        }
        next.finish_answered_batch();
        if next.phase == Phase::Tools {
            events.insert(0, event(&next, "turn.started", json!({})));
        }
        next.validate(channel)?;
        bounded(&next)?;
        Ok(Some(InputDelivery::Resolved {
            state: next,
            events,
        }))
    }

    /// Kept for private callers migrating from the ordinary-question API.
    pub fn question_continuation(
        &self,
        channel: &Channel,
        message: Value,
        cancelled: bool,
    ) -> Result<Option<(State, Vec<Value>)>> {
        if self.has_required_input() {
            return Ok(None);
        }
        match self.compose_input(channel, message, cancelled)? {
            Some(InputDelivery::Resolved { state, events }) => Ok(Some((state, events))),
            Some(InputDelivery::Deferred { .. }) => Err(INVALID),
            None => Ok(None),
        }
    }

    pub fn canonical_input(
        &self,
        channel: &Channel,
        original_run: &State,
        request: &str,
        decision: Decision,
    ) -> Result<(State, Vec<Value>)> {
        if original_run.issued_request(request).is_none() {
            return Err(STALE);
        }
        if original_run
            .decision(request)
            .is_some_and(|previous| previous != decision)
        {
            return Err(STALE);
        }
        self.canonical_inputs(channel, original_run, &[json!({"requestId":request,"optionId":if decision == Decision::Approved {"approve"} else {"deny"}})])
    }

    /// The journal proves each response's original issuance separately. The last
    /// delivery supplies authority; the first delivery remains only a receipt
    /// anchor. Source decisions here never manufacture application grants.
    pub fn canonical_inputs(
        &self,
        channel: &Channel,
        original_run: &State,
        responses: &[Value],
    ) -> Result<(State, Vec<Value>)> {
        self.canonical_inputs_with_limits(channel, original_run, responses, &[])
    }

    pub(crate) fn canonical_inputs_with_limits(
        &self,
        channel: &Channel,
        original_run: &State,
        responses: &[Value],
        earlier_limits: &[String],
    ) -> Result<(State, Vec<Value>)> {
        if responses.is_empty() || responses.len() > 128 {
            return Err(STALE);
        }
        typed_responses(responses)?;
        let mut next = self.rebind(channel, Some(original_run))?;
        for response in responses {
            let request = response["requestId"].as_str().ok_or(STALE)?;
            uuid::Uuid::parse_str(request).map_err(|_| STALE)?;
            let decision = match response["optionId"].as_str() {
                Some("approve") => Decision::Approved,
                Some("deny") => Decision::Denied,
                _ => return Err(STALE),
            };
            if original_run.issued_request(request).is_some()
                && original_run
                    .decision(request)
                    .is_some_and(|old| old != decision)
            {
                return Err(STALE);
            }
            next.decisions.insert(request.to_owned(), decision);
        }
        let payloads = responses
            .iter()
            .map(|response| json!({"inputResponses":[response]}))
            .collect::<Vec<_>>();
        let input =
            forge_core::agents::delivery::coalesce_payloads(&payloads).map_err(|_| INVALID)?;
        let (resolved, mut events) = next.deliver_input_with_limits(&input, earlier_limits)?;
        if resolved {
            events.insert(0, event(&next, "turn.started", json!({})));
        }
        next.validate(channel)?;
        bounded(&next)?;
        Ok((next, events))
    }

    /// Native tools checkpoint earlier than the source's adopted step. Preserve
    /// committed results and usage, but close every unfinished cancelled call
    /// rather than replaying a queued call or an ambiguous in-flight effect.
    /// Only ordinary questions and journal-proven earlier required requests may
    /// survive; the cancelled run's canonical grants cannot be revived.
    pub fn settle_cancelled_inputs(&self, preserved_required: &[String]) -> Result<State> {
        self.validate_structure()?;
        let allowed: HashSet<_> = preserved_required.iter().map(String::as_str).collect();
        let mut next = self.clone();
        next.compaction.active = None;
        next.pending_input = pending::clear_session_limit_prompt(&next.pending_input);
        next.budget.pending = None;
        if let Some(batch) = &mut next.pending_input.batch {
            batch.requests.retain(|request| {
                request["kind"] == "question"
                    || request["kind"] == "tool-approval"
                        && request["requestId"]
                            .as_str()
                            .is_some_and(|id| allowed.contains(id))
            });
            if batch.requests.is_empty() {
                next.pending_input.batch = None;
            }
        }
        let retained: HashSet<String> = next
            .pending_requests()
            .iter()
            .filter_map(|request| request["requestId"].as_str().map(str::to_owned))
            .collect();
        for call in &mut next.calls {
            if call.phase == CallPhase::Complete
                || call.phase == CallPhase::Waiting
                    && call
                        .request_id
                        .as_ref()
                        .is_some_and(|id| retained.contains(id))
            {
                continue;
            }
            let uncertain = call.phase == CallPhase::Calling;
            call.phase = CallPhase::Complete;
            call.output = Some(json!({"type":"execution-denied","reason":if uncertain {
                "The previous run was cancelled while this tool was in flight; its outcome is unknown and it will not be retried."
            } else {
                "The previous run was cancelled before this tool completed."
            }}));
            if call.name == "ask_question" && call.request_id.is_some() {
                let output = contract::question_output(None);
                call.output = Some(json!({"type":"json","value":output}));
                next.question_answers.insert(call.id.clone(), output);
            }
        }
        next.questions = next
            .pending_requests()
            .into_iter()
            .filter(|request| request["kind"] == "question")
            .collect();
        next.next_call = 0;
        next.phase = if next.pending_input.batch.is_some() {
            Phase::Waiting
        } else {
            Phase::Ready
        };
        next.finish_answered_batch();
        next.validate_structure()?;
        bounded(&next)?;
        Ok(next)
    }

    pub(crate) fn resolve_approval(
        &self,
        channel: &Channel,
        request: &str,
        decision: Decision,
    ) -> Result<Option<(State, Vec<Value>)>> {
        self.validate(channel)?;
        if self
            .questions
            .iter()
            .any(|question| question["requestId"] == request)
            || self.question_answers.contains_key(request)
        {
            return Err(Error(
                "A question requires a typed answer, not an approval decision.",
            ));
        }
        if let Some(previous) = self.decision(request) {
            return if previous == decision {
                Ok(None)
            } else {
                Err(STALE)
            };
        }
        self.canonical_input(channel, self, request, decision)
            .map(Some)
    }

    pub(crate) fn resolve_questions(
        &self,
        channel: &Channel,
        responses: &[Value],
    ) -> Result<Option<(State, Vec<Value>)>> {
        self.validate(channel)?;
        if responses.is_empty() || responses.len() > 128 {
            return Err(STALE);
        }
        let typed = typed_responses(responses)?;
        if self.questions.is_empty() {
            return if typed.iter().all(|(id, response)| {
                self.question_answers.get(id) == Some(&contract::question_output(Some(response)))
            }) {
                Ok(None)
            } else {
                Err(STALE)
            };
        }
        if typed.keys().any(|id| {
            !self
                .questions
                .iter()
                .any(|request| request["requestId"] == *id)
        }) {
            return Err(STALE);
        }
        let mut next = self.clone();
        let (_, events) = next.deliver_input(&json!({"inputResponses":responses}))?;
        next.revision = self.revision.checked_add(1).ok_or(INVALID)?;
        next.validate(channel)?;
        bounded(&next)?;
        Ok(Some((next, events)))
    }

    fn deliver_input(&mut self, input: &Value) -> Result<(bool, Vec<Value>)> {
        self.deliver_input_with_limits(input, &[])
    }

    fn deliver_input_with_limits(
        &mut self,
        input: &Value,
        earlier_limits: &[String],
    ) -> Result<(bool, Vec<Value>)> {
        let consumed =
            pending::consume_deferred(&self.pending_input, Some(input)).map_err(|_| INVALID)?;
        let mut source = consumed.state;
        let mut step = consumed.input;
        let pending_ids = self
            .pending_requests()
            .iter()
            .filter_map(|request| request["requestId"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        // Native session-limit requests use UUIDs, while the source identifies
        // its own limit IDs by a suffix. Preserve the same stale-drop boundary.
        if let Some(responses) = step
            .as_mut()
            .and_then(|input| input.get_mut("inputResponses"))
            .and_then(Value::as_array_mut)
        {
            responses.retain(|response| {
                let id = response["requestId"].as_str().unwrap_or_default();
                pending_ids.iter().any(|pending| pending == id)
                    || !earlier_limits.iter().any(|limit| limit == id)
                        && self
                            .issued_requests
                            .get(id)
                            .is_none_or(|request| request["kind"] != "session-limit")
            });
            if responses.is_empty() {
                step.as_mut()
                    .and_then(Value::as_object_mut)
                    .ok_or(INVALID)?
                    .remove("inputResponses");
            }
        }
        step = pending::prepare_stale(&self.messages, &pending_ids, step.as_ref())
            .map_err(|_| INVALID)?
            .step_input;
        // Native canonical approvals intentionally use approve/deny. Only the
        // pure SDK boundary uses the source continuation option IDs.
        if let Some(batch) = &mut source.batch {
            for request in &mut batch.requests {
                if request["kind"] == "session-limit" {
                    request["options"][0]["id"] = json!("continue");
                    request["options"][1]["id"] = json!("stop");
                    if let Some(responses) = step
                        .as_mut()
                        .and_then(|input| input.get_mut("inputResponses"))
                        .and_then(Value::as_array_mut)
                    {
                        for response in responses {
                            if response["requestId"] == request["requestId"] {
                                match response["optionId"].as_str() {
                                    Some("approve") => response["optionId"] = json!("continue"),
                                    Some("deny") => response["optionId"] = json!("stop"),
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        }
        let resolution =
            pending::resolve(&source, &[], step.as_ref(), None).map_err(|_| INVALID)?;
        let requests = self.pending_requests();
        self.pending_input = resolution.state;
        if let Some(batch) = &mut self.pending_input.batch {
            // Snapshot/public transport retains the native option mapping.
            batch.requests = requests.clone();
        }
        if resolution.outcome == pending::Outcome::Unresolved {
            self.phase = Phase::Complete;
            return Ok((false, delivery_events(self)));
        }
        let mut events = vec![];
        for request in requests {
            let id = request["requestId"].as_str().ok_or(INVALID)?;
            if request["kind"] == "session-limit" {
                if let Some(continuation) = &resolution.limit_continuation {
                    let decision = if continuation.granted {
                        Decision::Approved
                    } else {
                        Decision::Denied
                    };
                    self.decisions.insert(id.to_owned(), decision);
                    self.budget.pending.as_mut().ok_or(INVALID)?.decision = Some(decision);
                } else {
                    self.budget.pending = None;
                }
                continue;
            }
            let call = self
                .calls
                .iter_mut()
                .find(|call| call.request_id.as_deref() == Some(id))
                .ok_or(INVALID)?;
            if request["kind"] == "question" {
                let part = resolution
                    .tool_parts
                    .iter()
                    .find(|part| part["type"] == "tool-result" && part["toolCallId"] == call.id)
                    .ok_or(INVALID)?;
                let output = part["output"].clone();
                self.question_answers
                    .insert(call.id.clone(), output["value"].clone());
                call.output = Some(output.clone());
                call.phase = CallPhase::Complete;
                let result = json!({"callId":call.id,"kind":"tool-call","toolName":call.name,"output":output});
                events.push(event(
                    self,
                    "action.result",
                    json!({"result":result,"status":"completed"}),
                ));
            } else {
                let answer = resolution
                    .tool_parts
                    .iter()
                    .find(|part| {
                        part["type"] == "tool-approval-response" && part["approvalId"] == id
                    })
                    .ok_or(INVALID)?;
                let decision = if answer["approved"] == true {
                    Decision::Approved
                } else {
                    Decision::Denied
                };
                self.decisions.insert(id.to_owned(), decision);
                call.decision = Some(decision);
                if decision == Decision::Denied {
                    let output = resolution
                        .tool_parts
                        .iter()
                        .find(|part| part["type"] == "tool-result" && part["toolCallId"] == call.id)
                        .ok_or(INVALID)?["output"]
                        .clone();
                    call.output = Some(output.clone());
                    call.phase = CallPhase::Complete;
                    let result = json!({"callId":call.id,"kind":"tool-call","toolName":call.name,"output":output});
                    events.push(event(
                        self,
                        "action.result",
                        json!({"result":result,"status":"rejected"}),
                    ));
                } else {
                    call.phase = CallPhase::Queued;
                }
            }
        }
        self.questions.clear();
        self.next_call = 0;
        let followup = if resolution.deferred_message == Some(true) {
            self.pending_input
                .deferred_input
                .take()
                .and_then(|value| value.get("message").cloned())
        } else if resolution.consumed_message != Some(true) {
            step.and_then(|value| value.get("message").cloned())
        } else {
            None
        };
        if let Some(content) = followup {
            self.question_followup = Some(json!({"role":"user","content":content}));
        }
        self.phase = if self.calls.is_empty() {
            Phase::Ready
        } else {
            Phase::Tools
        };
        if self.calls.is_empty()
            && let Some(message) = self.question_followup.take()
        {
            self.messages.push(message);
        }
        Ok((true, events))
    }

    fn finish_answered_batch(&mut self) {
        if self.calls.is_empty()
            || self
                .calls
                .iter()
                .any(|call| call.phase != CallPhase::Complete)
        {
            return;
        }
        let results = self.calls.iter().map(|call| json!({"type":"tool-result","toolCallId":call.id,"toolName":call.name,"output":call.output})).collect::<Vec<_>>();
        self.messages.push(json!({"role":"tool","content":results}));
        if let Some(message) = self.question_followup.take() {
            self.messages.push(message);
        }
        self.calls.clear();
        self.next_call = 0;
        self.phase = Phase::Ready;
    }
}

fn validate_message(message: &Value) -> Result<()> {
    if message["role"] != "user"
        || message
            .as_object()
            .is_none_or(|object| object.len() != 2 || !object.contains_key("content"))
    {
        return Err(INVALID);
    }
    Ok(())
}
fn delivery_events(state: &State) -> Vec<Value> {
    vec![
        event(state, "turn.started", json!({})),
        event(state, "turn.completed", json!({})),
        event(state, "session.waiting", json!({})),
    ]
}
fn typed_responses(responses: &[Value]) -> Result<BTreeMap<String, Value>> {
    if responses.len() > 4096 {
        return Err(INVALID);
    }
    let mut result = BTreeMap::new();
    for response in responses {
        let response = contract::response(response.clone()).map_err(|_| STALE)?;
        result.insert(
            response["requestId"].as_str().ok_or(STALE)?.to_owned(),
            response,
        );
    }
    Ok(result)
}
fn bounded(state: &State) -> Result<()> {
    if forge_core::canonical::javascript_stringify(&state.snapshot()).len() > 8 * 1024 * 1024 {
        return Err(INVALID);
    }
    Ok(())
}
fn approval_request(call: &Call) -> Value {
    json!({"requestId":call.request_id,"kind":"tool-approval","display":"confirmation","prompt":format!("Approve tool call: {}", call.name),"allowFreeform":false,"options":[{"id":"approve","label":"Yes"},{"id":"deny","label":"No"}],"action":{"callId":call.id,"kind":"tool-call","toolName":call.name,"input":call.input}})
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

    pub(super) async fn collect_question(
        &self,
        state: &mut State,
        journal: &dyn Journal,
    ) -> Result<()> {
        let call = &state.calls[state.next_call];
        if let Err(error) = self.prepare_input(&call.name, call.input.clone()) {
            return self
                .settle_tool(
                    state,
                    journal,
                    json!({"type":"error-text","value":error.to_string()}),
                    "failed",
                )
                .await;
        }
        let mut next = state.clone();
        let call = &mut next.calls[next.next_call];
        if call.input_hash.as_deref()
            != Some(&forge_core::agents::approval::input_hash(&call.input))
            || call.request_id.is_some()
            || call.decision.is_some()
        {
            return Err(INVALID);
        }
        call.phase = CallPhase::Waiting;
        call.request_id = Some(call.id.clone());
        next.question_answers.remove(&call.id);
        next.next_call += 1;
        self.commit(state, journal, next, vec![]).await
    }

    pub(super) async fn park_input_batch(
        &self,
        state: &mut State,
        journal: &dyn Journal,
    ) -> Result<bool> {
        let approvals = state
            .calls
            .iter()
            .filter(|call| call.phase == CallPhase::Waiting && call.name != "ask_question")
            .map(approval_request);
        let questions = state
            .calls
            .iter()
            .filter(|call| call.phase == CallPhase::Waiting && call.name == "ask_question")
            .map(|call| contract::question(&call.id, &call.input));
        let requests = approvals.chain(questions).collect::<Vec<_>>();
        if requests.is_empty() {
            return Ok(false);
        }
        let mut next = state.clone();
        next.install_batch(requests.clone());
        next.phase = Phase::Waiting;
        next.next_call = 0;
        let events = vec![
            event(state, "input.requested", json!({"requests":requests})),
            event(state, "session.waiting", json!({"reason":"input-required"})),
        ];
        next.validate_structure()?;
        bounded(&next)?;
        self.commit(state, journal, next, events).await?;
        Ok(true)
    }
}
