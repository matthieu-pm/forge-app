//! Ordered subscription/refund transitions for provider-verified observations.
//! The store supplies locked state and executes the closed command set atomically.
//! Calling these rules alone never proves payment or authorizes a browser write.
use super::{
    calendar::{date, stamp},
    *,
};
use crate::{
    actor::Actor,
    subscription::{SubscriptionState, subscription_access},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
mod refund;
mod snapshot;

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Snapshot,
    Refund,
}
#[derive(Debug)]
pub struct Event {
    pub workspace: String,
    pub environment: String,
    pub event_id: String,
    pub body_hash: String,
    pub subscription: String,
    pub actor: Option<Actor>,
    kind: Kind,
    value: Value,
    plan_change: Option<Value>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub previous: Value,
    pub receipt: Value,
    pub member_role: Option<String>,
    pub workspace_exists: bool,
    pub now: DateTime<Utc>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum Command {
    EntitlementInsert { values: Value },
    EntitlementUpsert { values: Value, set: Value },
    EntitlementUpdate { set: Value },
    AuditInsert { values: Value },
    ReceiptInsert { values: Value },
    ReceiptUpdate { set: Value },
}
#[derive(Debug, Serialize)]
pub struct Plan {
    pub commands: Vec<Command>,
    pub answer: Value,
}
fn uuid(v: &Value) -> Result<Value> {
    if !crate::text::is_uuid(string(v)?) {
        return Err(invalid());
    }
    Ok(v.clone())
}
fn instant(v: &Value) -> Result<Value> {
    Ok(json!(stamp(date(v).map_err(|_| invalid())?)))
}
fn nullable_date(v: &Value) -> Result<Value> {
    if v.is_null() {
        Ok(Value::Null)
    } else {
        instant(v)
    }
}
fn required(v: &Value, key: &str) -> Result<Value> {
    v.get(key).cloned().ok_or_else(invalid)
}
fn iso(v: &Value) -> Result<Value> {
    if !super::money::INSTANT.is_match(string(v)?) {
        return Err(invalid());
    }
    date(v).map_err(|_| invalid())?;
    Ok(v.clone())
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn present(v: &Value) -> bool {
    !v.is_null()
}
fn before(a: &Value, b: &Value) -> bool {
    date(a).ok().zip(date(b).ok()).is_some_and(|(a, b)| a < b)
}
fn earliest(a: &Value, b: &Value) -> Value {
    if present(a) && before(a, b) {
        a.clone()
    } else {
        b.clone()
    }
}
fn extend(target: &mut Value, source: &Value) {
    target
        .as_object_mut()
        .expect("owned object")
        .extend(source.as_object().expect("owned object").clone());
}
fn defaults() -> Value {
    json!({"plan":"free","status":"active","source":"internal","sourceReference":null,"providerEnvironment":null,"providerUpdatedAt":null,"providerStateHash":null,"trialRedemptionId":null,"paidUpgradeOrderId":null,"terminatedAt":null,"unsupportedPauseAt":null,"paidActivatedAt":null,"paymentFailedAt":null,"graceExpiresAt":null,"currentPeriodStart":null,"currentPeriodEnd":null,"cancelAtPeriodEnd":false,"cancellationPeriodEnd":null,"refundedPeriods":[]})
}
impl Event {
    /// Parse/strip unknown fields just like the owning Zod schemas. All dates in
    /// snapshot values are serialized Dates; refund history retains its ISO bytes.
    pub fn parse(kind: Kind, input: &Value) -> Result<Self> {
        let event_id = crate::text::trim(string(&input["eventId"])?);
        let body_hash = string(&input["bodyHash"])?;
        if event_id.is_empty()
            || event_id.encode_utf16().count() > 255
            || body_hash.len() != 64
            || !body_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        let raw = &input[match kind {
            Kind::Snapshot => "snapshot",
            Kind::Refund => "refund",
        }];
        let workspace = string(&raw["workspaceId"])?;
        if workspace.is_empty() {
            return Err(invalid());
        }
        let environment = choice(&raw["environment"], &["sandbox", "production"])?;
        let subscription = uuid(&raw["subscriptionId"])?;
        let (value, plan_change, actor) = match kind {
            Kind::Snapshot => snapshot::parse(input)?,
            Kind::Refund => (refund::parse(raw)?, None, None),
        };
        Ok(Self {
            workspace: workspace.into(),
            environment: environment.into(),
            subscription: string(&subscription)?.into(),
            event_id: event_id.into(),
            body_hash: body_hash.into(),
            actor,
            kind,
            value,
            plan_change,
        })
    }
    pub fn plan(&self, context: &Context) -> Result<Plan> {
        if !context.workspace_exists {
            return Err(Error("BILLING_WORKSPACE_NOT_FOUND"));
        }
        if self.actor.is_some()
            && context.member_role.as_deref().is_none_or(|role| {
                !role
                    .split(',')
                    .map(crate::text::trim)
                    .any(|r| ["owner", "admin"].contains(&r))
            })
        {
            return Err(Error("BILLING_ACTOR_REVOKED"));
        }
        let r = &context.receipt;
        if !r.is_null()
            && (r["bodyHash"] != self.body_hash
                || r["workspaceId"] != self.workspace
                || r["subscriptionId"] != self.subscription)
        {
            return Err(Error("BILLING_EVENT_CONFLICT"));
        }
        let mut b = Builder {
            event: self,
            context,
            state: context.previous.clone(),
            commands: vec![],
        };
        match self.kind {
            Kind::Snapshot => snapshot::plan(&mut b),
            Kind::Refund => refund::plan(&mut b),
        }
    }
}
struct Builder<'a> {
    event: &'a Event,
    context: &'a Context,
    state: Value,
    commands: Vec<Command>,
}
impl Builder<'_> {
    fn effective_plan(&self) -> Value {
        let state = SubscriptionState::from_json(self.state.clone());
        serde_json::to_value(subscription_access(state.as_ref(), Some(self.context.now)).plan)
            .expect("plan")
    }
    fn emit(&mut self, command: Command) {
        match &command {
            Command::EntitlementUpsert { values, set } => {
                if self.state.is_null() {
                    self.state = defaults();
                    extend(&mut self.state, values)
                } else {
                    extend(&mut self.state, set)
                }
            }
            Command::EntitlementInsert { values } => {
                self.state = defaults();
                extend(&mut self.state, values)
            }
            Command::EntitlementUpdate { set } => extend(&mut self.state, set),
            _ => (),
        }
        self.commands.push(command);
    }
    fn upsert(&mut self, values: Value, set: Value) {
        self.emit(Command::EntitlementUpsert { values, set });
    }
    fn audit(&mut self, action: &str, after: Value) {
        self.emit(Command::AuditInsert{values:json!({"workspaceId":self.event.workspace,"actorUserId":self.event.actor.as_ref().map(|a|&a.user_id),"action":action,"target":self.event.subscription,"outcome":"succeeded","after":after,"requestId":self.event.event_id})});
    }
    fn finish(&mut self, outcome: Value, write_receipt: bool) -> Result<Plan> {
        let replayed = !self.context.receipt.is_null();
        if write_receipt {
            self.emit(if replayed {Command::ReceiptUpdate{set:json!({"outcome":outcome})}}else{Command::ReceiptInsert{values:json!({"workspaceId":self.event.workspace,"environment":self.event.environment,"eventId":self.event.event_id,"bodyHash":self.event.body_hash,"subscriptionId":self.event.subscription,"outcome":outcome})}});
        }
        let mut answer = json!({"outcome":outcome,"replayed":replayed});
        if matches!(self.event.kind, Kind::Snapshot) {
            answer["effectivePlan"] = self.effective_plan();
        }
        Ok(Plan {
            commands: std::mem::take(&mut self.commands),
            answer,
        })
    }
}
