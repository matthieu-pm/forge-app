//! Server-owned billing management contexts and durable renewal intents.
//! Neither an intent nor its confirmation establishes paid access.
use super::{
    calendar::{date, stamp},
    projection::{Command, Context, Plan, before, extend, hash, instant, iso, present, uuid},
    *,
};
use crate::{
    actor::Actor,
    subscription::{AccessPhase, SubscriptionState, subscription_access},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
mod currency;
mod refund;
pub use refund::{refund_identity, refund_renewal_context};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementContext {
    #[serde(flatten)]
    pub base: Context,
    pub requested: Value,
    pub pending: Value,
    pub capacity: Value,
}
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    CurrencyRequest,
    RefundRenewal,
}
#[derive(Debug)]
pub struct Prepared {
    pub workspace: String,
    pub environment: String,
    pub event_id: String,
    pub body_hash: String,
    pub subscription: String,
    pub actor: Option<Actor>,
    kind: Kind,
    value: Value,
    proof: Value,
}
pub fn live_member(role: Option<&str>) -> Result<()> {
    if role.is_none_or(|role| {
        !role
            .split(',')
            .map(crate::text::trim)
            .any(|r| ["owner", "admin"].contains(&r))
    }) {
        return Err(Error("BILLING_ACTOR_REVOKED"));
    }
    Ok(())
}
pub fn cancellation_context(
    actor: &Actor,
    environment: &str,
    role: Option<&str>,
    state: &Value,
) -> Result<Value> {
    identity(actor)?;
    live_member(role)?;
    if state["source"] != "polar" || state["providerEnvironment"] != environment {
        return Err(Error("BILLING_SUBSCRIPTION_NOT_FOUND"));
    }
    Ok(json!({"workspaceId":actor.workspace_id,"subscriptionId":uuid(&state["sourceReference"])?}))
}
pub fn plan_change_context(
    actor: &Actor,
    environment: &str,
    role: Option<&str>,
    state: &Value,
    capacity: &Value,
    now: DateTime<Utc>,
) -> Result<Value> {
    let mut binding = cancellation_context(actor, environment, role, state)?;
    let parsed = SubscriptionState::from_json(state.clone());
    let access = subscription_access(parsed.as_ref(), Some(now));
    let plan = serde_json::to_value(access.plan).expect("plan");
    if present(&state["unsupportedPauseAt"])
        || capacity.is_null()
        || access.phase != AccessPhase::Paid
        || ![json!("basic"), json!("business")].contains(&plan)
    {
        return Err(Error("BILLING_PAID_PLAN_REQUIRED"));
    }
    let refunded = !present(&state["paidUpgradeOrderId"])
        && state["refundedPeriods"].as_array().is_some_and(|periods| {
            periods.iter().any(|p| {
                p["kind"] == "upgrade"
                    && p["environment"] == environment
                    && p["subscriptionId"] == binding["subscriptionId"]
                    && before(&p["start"], &state["currentPeriodEnd"])
                    && before(&state["currentPeriodStart"], &p["end"])
            })
        });
    extend(
        &mut binding,
        &json!({"billableMembers":capacity["activeMemberCount"],"projectedPlan":if plan=="basic"{"starter"}else{"plus"},"refundedUpgrade":refunded}),
    );
    Ok(binding)
}
impl Prepared {
    pub fn currency(actor: &Actor, value: &Value) -> Result<Self> {
        currency::prepare(actor, value)
    }
    pub fn refund_renewal(value: &Value, proof: &Value) -> Result<Self> {
        refund::prepare(value, proof)
    }
    pub fn plan(&self, ctx: &ManagementContext) -> Result<Plan> {
        if !ctx.base.workspace_exists {
            return Err(Error("BILLING_WORKSPACE_NOT_FOUND"));
        }
        match self.kind {
            Kind::CurrencyRequest => currency::plan(self, ctx),
            Kind::RefundRenewal => refund::plan(self, ctx),
        }
    }
    fn check_receipt(&self, receipt: &Value) -> Result<bool> {
        if receipt.is_null() {
            return Ok(false);
        }
        if receipt["bodyHash"] != self.body_hash
            || receipt["workspaceId"] != self.workspace
            || receipt["subscriptionId"] != self.subscription
        {
            return Err(Error("BILLING_EVENT_CONFLICT"));
        }
        Ok(true)
    }
    fn receipt(&self, outcome: &str) -> Command {
        Command::ReceiptInsert {
            values: json!({"workspaceId":self.workspace,"environment":self.environment,"eventId":self.event_id,"bodyHash":self.body_hash,"subscriptionId":self.subscription,"outcome":outcome}),
        }
    }
}
