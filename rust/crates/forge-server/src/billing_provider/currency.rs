//! Provider-country renewal intent. Recording never claims a currency PATCH.
use super::reconciliation::SnapshotSink;
use super::{
    Client, Clock, Error, ManagementContext, Subscriptions, coerce_date, hash_bytes, uuid,
};
use async_trait::async_trait;
use forge_core::{actor::Actor, billing};
use serde_json::{Value, json};
use std::sync::Arc;

#[async_trait]
pub trait CurrencyRequestSink: Send + Sync {
    async fn record(&self, actor: &Actor, input: Value) -> Result<Value, Error>;
}
#[async_trait]
impl CurrencyRequestSink for forge_store::billing::Service {
    async fn record(&self, actor: &Actor, input: Value) -> Result<Value, Error> {
        Ok(self.record_renewal_currency_request(actor, input).await?)
    }
}
pub struct CurrencyPlanner {
    pub client: Arc<Client>,
    pub context: Arc<dyn ManagementContext>,
    pub record: Arc<dyn CurrencyRequestSink>,
    pub project: Arc<dyn SnapshotSink>,
    pub clock: Clock,
}
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
impl CurrencyPlanner {
    pub async fn request(&self, actor: &Actor, request_id: &str) -> Result<Value, Error> {
        let identity = billing::identity(actor)?;
        let key = json!(request_id);
        let key = uuid(&key)?;
        let context = self.context.resolve(actor).await?;
        let id = uuid(&context["subscriptionId"])?;
        if context["workspaceId"] != identity["workspaceId"] {
            return Err(Error("BILLING_ACTOR_WORKSPACE_MISMATCH"));
        }
        let current = self.client.get(id).await?;
        let snapshot =
            billing::provider::snapshot(&self.client.config, &actor.workspace_id, id, &current)?;
        if !snapshot["terminatedAt"].is_null() || !snapshot["unsupportedPauseAt"].is_null() {
            let event_id = format!(
                "forge.currency.restricted.{id}.{}",
                super::string(&snapshot["updatedAt"])?
            );
            self.project.apply(json!({"eventId":event_id,"bodyHash":hash_bytes(event_id.as_bytes()),"snapshot":snapshot,"actor":actor})).await?;
            return Err(Error("BILLING_CURRENCY_SUBSCRIPTION_NOT_RENEWING"));
        }
        let start = billing::calendar::date(&snapshot["currentPeriodStart"])?;
        let end = billing::calendar::date(&snapshot["currentPeriodEnd"])?;
        if snapshot["status"] != "active"
            || snapshot["cancelAtPeriodEnd"] == true
            || truthy(&current["ends_at"])
            || truthy(&current["ended_at"])
            || start > (self.clock)()
            || end <= (self.clock)()
        {
            return Err(Error("BILLING_CURRENCY_SUBSCRIPTION_NOT_RENEWING"));
        }
        let currency = billing::schema("currency", current["currency"].clone())?;
        let country =
            billing::country(&current["customer"]["billing_address"]["country"])?["country"]
                .clone();
        let pending = &current["pending_update"];
        if truthy(pending)
            && (pending.get("units") != Some(&Value::Null)
                || coerce_date(pending.get("applies_at")).map(|date| date.timestamp_millis())
                    != Some(end.timestamp_millis())
                || (pending.get("product_id") != Some(&Value::Null)
                    && !(snapshot["plan"] == "plus"
                        && pending["product_id"]
                            == self.client.config.paid_products["starter"]
                                [super::string(&currency)?]))
                || (pending.get("product_id") == Some(&Value::Null)
                    && pending.get("seats") == Some(&Value::Null)))
        {
            return Err(Error("BILLING_PENDING_CHANGE_CONFLICT"));
        }
        if let Some(seats) = pending.get("seats").filter(|v| !v.is_null()) {
            billing::safe_integer(seats, 1)?;
        }
        let renewal_plan = if truthy(&pending["product_id"]) {
            json!("starter")
        } else {
            snapshot["plan"].clone()
        };
        if context["projectedPlan"] != snapshot["plan"]
            && !(truthy(&context["refundedUpgrade"])
                && context["projectedPlan"] == "starter"
                && renewal_plan == "starter")
        {
            return Err(Error("BILLING_CURRENCY_PLAN_UNRECONCILED"));
        }
        let fresh = self.context.resolve(actor).await?;
        if fresh.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if fresh["workspaceId"] != identity["workspaceId"]
            || fresh["subscriptionId"] != id
            || fresh.get("projectedPlan") != context.get("projectedPlan")
            || fresh.get("refundedUpgrade") != context.get("refundedUpgrade")
        {
            return Err(Error("BILLING_CURRENCY_CONTEXT_CHANGED"));
        }
        self.record.record(actor, json!({"requestId":key,"workspaceId":identity["workspaceId"],"environment":self.client.config.environment,"subscriptionId":id,"billingCountry":country,"fromCurrency":currency,"currentPlan":context["projectedPlan"],"renewalPlan":renewal_plan,"periodStart":snapshot["currentPeriodStart"],"periodEnd":snapshot["currentPeriodEnd"],"providerUpdatedAt":snapshot["updatedAt"]})).await
    }
}
