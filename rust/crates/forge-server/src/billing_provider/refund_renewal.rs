//! Reconcile Starter renewal after a verified upgrade refund, without new access.
use super::currency::truthy;
use super::{Client, Clock, Error, Subscriptions, coerce_date, hash_bytes, uuid};
use async_trait::async_trait;
use forge_core::billing;
use serde_json::{Value, json};
use std::sync::Arc;

#[async_trait]
pub trait RefundRenewalStore: Send + Sync {
    async fn read(&self, input: &Value) -> Result<Value, Error>;
    async fn confirm(&self, input: &Value, proof: Value) -> Result<Value, Error>;
    async fn project(&self, event: Value) -> Result<Value, Error>;
}
#[async_trait]
impl RefundRenewalStore for forge_store::billing::Service {
    async fn read(&self, input: &Value) -> Result<Value, Error> {
        Ok(self.upgrade_refund_renewal_context(input.clone()).await?)
    }
    async fn confirm(&self, input: &Value, proof: Value) -> Result<Value, Error> {
        Ok(self
            .confirm_upgrade_refund_renewal(input.clone(), proof)
            .await?)
    }
    async fn project(&self, event: Value) -> Result<Value, Error> {
        Ok(self.apply_subscription_snapshot(event).await?)
    }
}
#[async_trait]
pub trait RenewalSink: Send + Sync {
    async fn reconcile(&self, input: &Value) -> Result<Value, Error>;
}
pub struct RefundRenewal {
    pub client: Arc<Client>,
    pub store: Arc<dyn RefundRenewalStore>,
    pub clock: Clock,
}
#[async_trait]
impl RenewalSink for RefundRenewal {
    async fn reconcile(&self, input: &Value) -> Result<Value, Error> {
        RefundRenewal::reconcile(self, input).await
    }
}
struct Observation {
    value: Value,
    snapshot: Value,
    seats: u64,
    renewal_seats: u64,
    currency: Value,
}
fn disposition(context: &Value) -> Result<Value, Error> {
    if context.is_null() {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    let mut output = serde_json::Map::new();
    if let Some(status) = context.get("status") {
        output.insert("status".into(), status.clone());
    }
    output.insert("replayed".into(), json!(false));
    Ok(Value::Object(output))
}
impl RefundRenewal {
    async fn observe(
        &self,
        input: &Value,
        context: &Value,
        id: &str,
    ) -> Result<Option<Observation>, Error> {
        let value = self.client.get(id).await?;
        let snapshot = billing::provider::snapshot(
            &self.client.config,
            super::string(&input["workspaceId"])?,
            id,
            &value,
        )?;
        if !snapshot["terminatedAt"].is_null() || !snapshot["unsupportedPauseAt"].is_null() {
            let event_id = format!(
                "forge.refund-renewal.restricted.{id}.{}",
                super::string(&snapshot["updatedAt"])?
            );
            self.store.project(json!({"eventId":event_id,"bodyHash":hash_bytes(event_id.as_bytes()),"snapshot":snapshot})).await?;
            if !snapshot["unsupportedPauseAt"].is_null() && snapshot["terminatedAt"].is_null() {
                return Err(Error("BILLING_SUBSCRIPTION_PAUSE_UNSUPPORTED"));
            }
            return Ok(None);
        }
        if snapshot["currentPeriodStart"] != context["start"]
            || snapshot["currentPeriodEnd"] != context["end"]
            || (self.clock)() >= billing::calendar::date(&snapshot["currentPeriodEnd"])?
        {
            return Err(Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT"));
        }
        if (value["status"] != "active" && value["status"] != "past_due")
            || truthy(&value["cancel_at_period_end"])
            || truthy(&value["pause_at_period_end"])
            || value.get("paused_at") != Some(&Value::Null)
            || value.get("ends_at") != Some(&Value::Null)
            || value.get("ended_at") != Some(&Value::Null)
        {
            return Err(Error("BILLING_REFUND_RENEWAL_NOT_RENEWING"));
        }
        let seats = billing::safe_integer(&value["seats"], 1)?;
        let pending = &value["pending_update"];
        let currency = billing::schema("currency", value["currency"].clone())?;
        if truthy(pending)
            && (pending.get("units") != Some(&Value::Null)
                || coerce_date(pending.get("applies_at"))
                    .ok_or(Error("INVALID_BILLING_INPUT"))?
                    .to_iso_string()
                    != context["end"]
                || (pending.get("product_id") != Some(&Value::Null)
                    && !(snapshot["plan"] == "plus"
                        && pending["product_id"]
                            == self.client.config.paid_products["starter"]
                                [super::string(&currency)?]))
                || (pending.get("seats") == Some(&Value::Null)
                    && pending.get("product_id") == Some(&Value::Null)))
        {
            return Err(Error("BILLING_PENDING_CHANGE_CONFLICT"));
        }
        let renewal_seats = match pending.get("seats").filter(|v| !v.is_null()) {
            Some(v) => billing::safe_integer(v, 1)?,
            None => seats,
        };
        Ok(Some(Observation {
            value,
            snapshot,
            seats,
            renewal_seats,
            currency,
        }))
    }
    pub async fn reconcile(&self, input: &Value) -> Result<Value, Error> {
        if input.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if input["environment"] != self.client.config.environment {
            return Err(Error("BILLING_REFUND_ENVIRONMENT_CONFLICT"));
        }
        let id = uuid(&input["subscriptionId"])?;
        let context = self.store.read(input).await?;
        if context.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if context["status"] != "required" {
            return disposition(&context);
        }
        let Some(before) = self.observe(input, &context, id).await? else {
            return Ok(json!({"status":"terminated","replayed":false}));
        };
        let after = if before.snapshot["plan"] == "plus"
            && before.value["pending_update"]["product_id"]
                != self.client.config.paid_products["starter"][super::string(&before.currency)?]
        {
            let fresh = self.store.read(input).await?;
            if fresh.is_null() {
                return Err(Error("INVALID_BILLING_INPUT"));
            }
            if fresh["status"] != "required" {
                return disposition(&fresh);
            }
            if fresh.get("revision") != context.get("revision") {
                return Err(Error("BILLING_REFUND_RENEWAL_CONTEXT_CHANGED"));
            }
            self.client.update(id, json!({"product_id":self.client.config.paid_products["starter"][super::string(&before.currency)?],"proration_behavior":"next_period"})).await?;
            let Some(after) = self.observe(input, &context, id).await? else {
                return Ok(json!({"status":"terminated","replayed":false}));
            };
            after
        } else {
            Observation {
                value: before.value.clone(),
                snapshot: before.snapshot.clone(),
                seats: before.seats,
                renewal_seats: before.renewal_seats,
                currency: before.currency.clone(),
            }
        };
        if after.snapshot["plan"] != before.snapshot["plan"]
            || after.value.get("amount") != before.value.get("amount")
            || after.currency != before.currency
            || after.seats != before.seats
            || after.renewal_seats != before.renewal_seats
            || (after.snapshot["plan"] == "plus"
                && after.value["pending_update"]["product_id"]
                    != self.client.config.paid_products["starter"][super::string(&after.currency)?])
        {
            return Err(Error("BILLING_REFUND_RENEWAL_NOT_CONFIRMED"));
        }
        self.store.confirm(input, json!({"revision":context["revision"],"effectiveAt":context["end"],"providerUpdatedAt":after.snapshot["updatedAt"],"currency":after.currency,"productId":self.client.config.paid_products["starter"][super::string(&after.currency)?],"billedSeats":after.seats,"renewalSeats":after.renewal_seats,"status":if after.snapshot["plan"]=="starter"{"already-starter"}else{"scheduled"}})).await
    }
}
