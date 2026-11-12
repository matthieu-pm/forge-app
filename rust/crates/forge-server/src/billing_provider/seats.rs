//! Renewal-only quantity adapter. The owning command supplies serialized,
//! current workspace authority; this adapter does not expose a public action.
use super::{Client, Clock, Error, ManagementContext, Subscriptions, coerce_date};
use chrono::{DateTime, Utc};
use forge_core::{actor::Actor, billing};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct Scheduler {
    pub client: Arc<Client>,
    pub subscriptions: Arc<dyn Subscriptions>,
    pub context: Arc<dyn ManagementContext>,
    pub clock: Clock,
}
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
/// Strict primitive equality retains missing/null distinctions and JS numbers.
pub(super) fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        _ => false,
    }
}
pub(super) fn period(
    workspace: &str,
    now: DateTime<Utc>,
    start: Option<&Value>,
    end: Option<&Value>,
) -> Result<Value, Error> {
    if forge_core::text::trim(workspace).is_empty() {
        return Err(Error("Workspace identity is required."));
    }
    let invalid = Error("A valid workspace usage-period timestamp is required.");
    let start = coerce_date(start).ok_or_else(|| invalid.clone())?;
    let end = coerce_date(end).ok_or(invalid)?;
    // The paid-period branch only compares timestamps. Retain the complete JS
    // Date range instead of narrowing it through chrono's calendar parser.
    if start >= end
        || now.timestamp_millis() < start.timestamp_millis()
        || now.timestamp_millis() >= end.timestamp_millis()
    {
        return Err(Error(
            "Refresh the paid workspace's authoritative billing period before admitting usage.",
        ));
    }
    let start = start.to_iso_string();
    let end = end.to_iso_string();
    let key = serde_json::to_string(&json!(["forge.ai-usage-period", workspace, start, end]))
        .expect("period identity is serializable");
    Ok(json!({"workspaceId":workspace,"start":start,"end":end,"key":key}))
}
struct Validated {
    current_seats: u64,
    renewal_seats: u64,
    period: Value,
    pending_product: Value,
}
impl Scheduler {
    fn validate(
        &self,
        subscription: &Value,
        id: &str,
        workspace: &str,
        now: DateTime<Utc>,
    ) -> Result<Validated, Error> {
        if subscription.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if subscription["id"] != id {
            return Err(Error(
                "Subscription does not belong to the active workspace.",
            ));
        }
        let customer = subscription
            .get("customer")
            .filter(|v| !v.is_null())
            .ok_or(Error("INVALID_BILLING_INPUT"))?;
        if customer["external_id"] != format!("forge:workspace:{workspace}") {
            return Err(Error(
                "Subscription does not belong to the active workspace.",
            ));
        }
        let currency = billing::schema("currency", subscription["currency"].clone())?;
        let currency = currency.as_str().expect("validated currency");
        if !self
            .client
            .config
            .paid_products
            .as_object()
            .is_some_and(|products| {
                products
                    .values()
                    .any(|product| product[currency] == subscription["product_id"])
            })
            || subscription["recurring_interval"] != "month"
            || subscription["recurring_interval_count"].as_f64() != Some(1.)
        {
            return Err(Error(
                "Subscription is outside the approved monthly catalog.",
            ));
        }
        if subscription["status"] != "active"
            || truthy(&subscription["cancel_at_period_end"])
            || truthy(&subscription["pause_at_period_end"])
            || ["paused_at", "ends_at", "ended_at"]
                .iter()
                .any(|key| subscription.get(*key) != Some(&Value::Null))
        {
            return Err(Error("Subscription is not actively renewing."));
        }
        let current_seats = billing::safe_integer(&subscription["seats"], 1)?;
        let period = period(
            workspace,
            now,
            subscription.get("current_period_start"),
            subscription.get("current_period_end"),
        )?;
        let pending = &subscription["pending_update"];
        let pending_product = pending
            .get("product_id")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null);
        let valid_downgrade = pending_product
            == self.client.config.paid_products["starter"][currency]
            && subscription["product_id"] == self.client.config.paid_products["plus"][currency];
        if truthy(pending)
            && ((!pending_product.is_null() && !valid_downgrade)
                || pending.get("units") != Some(&Value::Null)
                || (pending.get("seats") == Some(&Value::Null) && pending_product.is_null())
                || coerce_date(pending.get("applies_at")) != coerce_date(period.get("end")))
        {
            return Err(Error(
                "Reconcile the conflicting scheduled subscription change.",
            ));
        }
        let renewal_seats = pending
            .get("seats")
            .filter(|v| !v.is_null())
            .map(|v| billing::safe_integer(v, 1))
            .transpose()?
            .unwrap_or(current_seats);
        Ok(Validated {
            current_seats,
            renewal_seats,
            period,
            pending_product,
        })
    }
    pub async fn schedule(&self, actor: &Actor) -> Result<Value, Error> {
        let identity = billing::identity(actor)?;
        let context = self.context.resolve(actor).await?;
        if context["workspaceId"] != identity["workspaceId"] {
            return Err(Error(
                "Billing context does not match the active workspace.",
            ));
        }
        let id = super::uuid(&context["subscriptionId"])?;
        let seats = billing::safe_integer(&context["billableMembers"], 1)?;
        let before = self.subscriptions.get(id).await?;
        let now = (self.clock)();
        let current = self.validate(&before, id, &actor.workspace_id, now)?;
        let result = |status: &str| json!({"status":status,"billedSeats":current.current_seats,"renewalSeats":seats,"effectiveAt":current.period["end"]});
        if current.renewal_seats == seats {
            return Ok(result("unchanged"));
        }
        let after = self
            .subscriptions
            .update(
                id,
                json!({"seats":seats,"proration_behavior":"next_period"}),
            )
            .await?;
        let confirmed = self.validate(&after, id, &actor.workspace_id, now)?;
        if !same(after.get("product_id"), before.get("product_id"))
            || !same(after.get("currency"), before.get("currency"))
            || !same(after.get("amount"), before.get("amount"))
            || confirmed.current_seats != current.current_seats
            || confirmed.renewal_seats != seats
            || confirmed.pending_product != current.pending_product
            || (seats == current.current_seats
                && after["pending_update"]
                    .get("seats")
                    .is_some_and(|v| !v.is_null()))
            || confirmed.period["key"] != current.period["key"]
        {
            return Err(Error(
                "Seat update requires reconciliation before confirmation.",
            ));
        }
        Ok(result(if seats == current.current_seats {
            "cleared"
        } else {
            "scheduled"
        }))
    }
}
