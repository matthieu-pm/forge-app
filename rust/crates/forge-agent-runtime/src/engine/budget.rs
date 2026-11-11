//! Session usage survives user turns. A continuation grants a new allowance only
//! through a durable, run-bound decision; it never authorizes a model tool.
use super::{Decision, Engine, Journal, Phase, State, state::INVALID, turn::event};
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

const MAX: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Usage {
    pub input: u64,
    pub output: u64,
}
impl Usage {
    fn add(self, other: Self) -> Result<Self> {
        Ok(Self {
            input: self
                .input
                .checked_add(other.input)
                .filter(|n| *n <= MAX)
                .ok_or(INVALID)?,
            output: self
                .output
                .checked_add(other.output)
                .filter(|n| *n <= MAX)
                .ok_or(INVALID)?,
        })
    }
    fn valid(self) -> bool {
        self.input <= MAX && self.output <= MAX
    }
    fn positive(self) -> bool {
        self.valid() && self.input > 0 && self.output > 0
    }
    fn get(self, kind: Kind) -> u64 {
        match kind {
            Kind::Input => self.input,
            Kind::Output => self.output,
        }
    }
    fn violation(self, usage: Self) -> Option<Kind> {
        if usage.input >= self.input {
            Some(Kind::Input)
        } else if usage.output >= self.output {
            Some(Kind::Output)
        } else {
            None
        }
    }
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Kind {
    Input,
    Output,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::Output => "output",
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Budget {
    pub prior: Usage,
    pub granted: Option<Usage>,
    pub pending: Option<Pending>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pending {
    pub request_id: String,
    kind: Kind,
    limit: u64,
    used_tokens: u64,
    grant: Usage,
    resume: Phase,
    pub decision: Option<Decision>,
}
impl State {
    pub(super) fn total_usage(&self) -> Result<Usage> {
        self.budget.prior.add(Usage {
            input: self.input_tokens,
            output: self.output_tokens,
        })
    }
    pub fn session_usage(&self) -> (u64, u64) {
        let total = self.total_usage().expect("validated session usage");
        (total.input, total.output)
    }
    pub(super) fn validate_budget(&self) -> Result<()> {
        let usage = self.total_usage()?;
        if !self.budget.prior.valid() || self.budget.granted.is_some_and(|v| !v.positive()) {
            return Err(INVALID);
        }
        if let Some(p) = &self.budget.pending
            && (Uuid::parse_str(&p.request_id).is_err()
                || !matches!(p.resume, Phase::Ready | Phase::Generating)
                || !self.calls.is_empty()
                || self.next_call != 0
                || p.limit == 0
                || p.limit > MAX
                || p.used_tokens != usage.get(p.kind)
                || !p.grant.positive()
                || p.grant.input <= usage.input
                || p.grant.output <= usage.output
                || p.grant.get(p.kind) - p.used_tokens != p.limit
                || self.budget.granted.is_none() && p.used_tokens < p.limit
                || self
                    .budget
                    .granted
                    .is_some_and(|v| usage.get(p.kind) < v.get(p.kind))
                || match p.decision {
                    None => {
                        self.phase != Phase::Waiting || self.decisions.contains_key(&p.request_id)
                    }
                    Some(d) => {
                        self.phase != Phase::Ready || self.decisions.get(&p.request_id) != Some(&d)
                    }
                })
        {
            return Err(INVALID);
        }
        Ok(())
    }
}
impl Engine {
    fn configured_budget(&self) -> Usage {
        Usage {
            input: self.max_input_tokens,
            output: self.max_output_tokens,
        }
    }
    pub(super) fn remaining_output(&self, state: &State) -> Result<u32> {
        Ok(state
            .budget
            .granted
            .unwrap_or(self.configured_budget())
            .output
            .saturating_sub(state.total_usage()?.output)
            .min(u32::MAX as u64) as u32)
    }
    pub(super) async fn check_budget(
        &self,
        state: &mut State,
        journal: &dyn Journal,
    ) -> Result<bool> {
        let usage = state.total_usage()?;
        let configured = self.configured_budget();
        let runtime = state.budget.granted.unwrap_or(configured);
        let Some(kind) = runtime.violation(usage) else {
            return Ok(false);
        };
        let grant = usage.add(configured)?;
        let pending = Pending {
            request_id: Uuid::new_v4().to_string(),
            kind,
            limit: configured.get(kind),
            used_tokens: usage.get(kind),
            grant,
            resume: state.phase,
            decision: None,
        };
        let prompt = prompt(kind, pending.limit);
        // The private UUID and approve/deny options are Forge transport bindings.
        // The source's continuation is not a model-supplied function invocation.
        let request = json!({"requestId":pending.request_id,"kind":"session-limit","display":"confirmation","allowFreeform":false,"prompt":prompt,
            "options":[{"id":"approve","label":"Approve","description":"Grant a fresh token budget","style":"primary"},{"id":"deny","label":"Stop","description":"Stop now","style":"danger"}],
            "action":{"callId":pending.request_id,"kind":"tool-call","toolName":"session_limit_continuation","input":{"kind":kind,"limit":pending.limit,"usedTokens":pending.used_tokens}}});
        let mut next = state.clone();
        next.phase = Phase::Waiting;
        next.budget.pending = Some(pending);
        let mut events = vec![];
        if state.step == 0 && state.phase == Phase::Ready {
            events.push(event(state, "turn.started", json!({})));
        }
        events.push(event(
            state,
            "input.requested",
            json!({"requests":[request]}),
        ));
        events.push(event(
            state,
            "session.waiting",
            json!({"reason":"input-required"}),
        ));
        self.commit(state, journal, next, events).await?;
        Ok(true)
    }
    pub(super) async fn apply_budget_decision(
        &self,
        state: &mut State,
        journal: &dyn Journal,
    ) -> Result<()> {
        let pending = state.budget.pending.as_ref().ok_or(INVALID)?;
        let decision = pending.decision.ok_or(INVALID)?;
        let mut next = state.clone();
        next.budget.pending = None;
        let events = if decision == Decision::Approved {
            next.budget.granted = Some(pending.grant);
            next.phase = pending.resume;
            vec![]
        } else {
            next.phase = Phase::Cancelled;
            vec![
                event(
                    state,
                    "turn.cancelled",
                    json!({"reason":"session-limit-declined"}),
                ),
                event(state, "session.waiting", json!({})),
            ]
        };
        self.commit(state, journal, next, events).await
    }
}
fn prompt(kind: Kind, limit: u64) -> String {
    format!(
        "This session has hit the {}-token limit ({}) per session. This is a guardrail against defective long-running sessions. If session activity looks fine, just approve to keep going.",
        kind.name(),
        compact(limit)
    )
}
// The configured source uses Number.toFixed(1), which rounds exact binary ties
// upwards. Scale the IEEE-754 rational exactly instead of Rust's ties-to-even.
fn compact(value: u64) -> String {
    let (scale, suffix) = if value >= 1_000_000 {
        (1_000_000., "M")
    } else if value >= 1_000 {
        (1_000., "K")
    } else {
        return value.to_string();
    };
    let number = value as f64 / scale;
    let bits = number.to_bits();
    let mantissa = u128::from((bits & ((1_u64 << 52) - 1)) | (1_u64 << 52)) * 10;
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023 - 52;
    let rounded = if exponent >= 0 {
        mantissa << exponent
    } else {
        let denominator = 1_u128 << -exponent;
        (mantissa + denominator / 2) / denominator
    };
    if rounded.is_multiple_of(10) {
        format!("{}{suffix}", rounded / 10)
    } else {
        format!("{}.{:01}{suffix}", rounded / 10, rounded % 10)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn token_budget_arithmetic_and_prompts_match_pinned_session_reference() {
        let reference: Value =
            serde_json::from_str(include_str!("../../data/session-budget-reference.json")).unwrap();
        for case in reference["limits"].as_array().unwrap() {
            let usage: Usage = serde_json::from_value(case["usage"].clone()).unwrap();
            let configured: Usage = serde_json::from_value(case["configured"].clone()).unwrap();
            let runtime: Usage = serde_json::from_value(case["runtime"].clone()).unwrap();
            assert_eq!(json!(usage.add(configured).unwrap()), case["grant"]);
            assert_eq!(
                json!({"input":runtime.input.saturating_sub(usage.input),"output":runtime.output.saturating_sub(usage.output)}),
                case["remaining"]
            );
            let violation=runtime.violation(usage).map(|kind|json!({"kind":kind,"limit":configured.get(kind),"usedTokens":usage.get(kind)}));
            assert_eq!(json!(violation), case["violation"]);
        }
        for request in reference["requests"].as_array().unwrap() {
            let kind: Kind =
                serde_json::from_value(request["action"]["input"]["kind"].clone()).unwrap();
            let limit = request["action"]["input"]["limit"].as_u64().unwrap();
            assert_eq!(prompt(kind, limit), request["prompt"]);
        }
        assert!(
            Usage {
                input: MAX,
                output: 0
            }
            .add(Usage {
                input: 1,
                output: 0
            })
            .is_err()
        );
    }
}
