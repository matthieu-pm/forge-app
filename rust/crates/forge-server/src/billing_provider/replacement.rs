use super::{Client, Clock, Error, Operation, string, uuid};
use async_trait::async_trait;
use chrono::Datelike;
use forge_core::{
    actor::Actor,
    billing::{
        self,
        calendar::{self, date, stamp},
        provider::{self, instant},
    },
};
use serde_json::{Value, json};
use std::sync::Arc;

#[async_trait]
pub trait Context: Send + Sync {
    async fn resolve(&self, actor: &Actor, request: &str) -> Result<Value, Error>;
}
pub struct Verifier {
    pub client: Arc<Client>,
    pub context: Arc<dyn Context>,
    pub clock: Clock,
}
fn invalid() -> Error {
    Error("INVALID_BILLING_INPUT")
}
fn refused() -> Error {
    Error("BILLING_REPLACEMENT_PAYMENT_UNVERIFIED")
}
fn context(raw: &Value) -> Result<Value, Error> {
    let workspace = string(&raw["workspaceId"])?;
    if workspace.is_empty() {
        return Err(invalid());
    }
    let environment = string(&raw["environment"])?;
    if !["sandbox", "production"].contains(&environment) {
        return Err(invalid());
    }
    let day = billing::safe_integer(&raw["anchorDay"], 1)?;
    if day > 31 {
        return Err(invalid());
    }
    let normalized = |key: &str| date(&raw[key]).map(stamp).map_err(|_| invalid());
    Ok(
        json!({"requestId":uuid(&raw["requestId"] )?,"workspaceId":workspace,"environment":environment,"sourceSubscriptionId":uuid(&raw["sourceSubscriptionId"] )?,"targetCurrency":billing::schema("currency",raw["targetCurrency"].clone())?,"renewalPlan":billing::schema("selfServePlan",raw["renewalPlan"].clone())?,"renewalMembers":billing::safe_integer(&raw["renewalMembers"],1)?,"renewalPriceMinor":billing::safe_integer(&raw["renewalPriceMinor"],1)?,"originalPeriodStart":normalized("originalPeriodStart")?,"effectiveAt":normalized("effectiveAt")?,"anchorDay":day,"nextRenewalAt":normalized("nextRenewalAt")?,"checkoutGraceEndsAt":normalized("checkoutGraceEndsAt")?}),
    )
}
fn explicit_null(value: &Value, key: &str) -> bool {
    value.get(key) == Some(&Value::Null)
}
impl Verifier {
    /// Payment and calendar evidence produce a plan only. No provider write,
    /// subscription rebind, entitlement grant or fresh allowance occurs here.
    pub async fn plan(
        &self,
        actor: &Actor,
        request_id: &str,
        order_id: &str,
    ) -> Result<Value, Error> {
        let identity = billing::identity(actor)?;
        let request = uuid(&json!(request_id))?.to_owned();
        let order_key = uuid(&json!(order_id))?.to_owned();
        let original = context(&self.context.resolve(actor, &request).await?)?;
        if original["requestId"] != request
            || original["workspaceId"] != identity["workspaceId"]
            || original["environment"] != self.client.config.environment
        {
            return Err(Error("BILLING_REPLACEMENT_CONTEXT_CHANGED"));
        }
        let price = billing::evaluate(
            "price",
            &json!({"plan":original["renewalPlan"],"members":original["renewalMembers"]}),
        )
        .map_err(|e| {
            if e.0 == "BILLING_INTEGER_OVERFLOW" {
                Error("Workspace price exceeds the supported range.")
            } else {
                e.into()
            }
        })?;
        if price != original["renewalPriceMinor"] {
            return Err(Error("BILLING_REPLACEMENT_CONTEXT_CHANGED"));
        }
        let order = self
            .client
            .request(Operation::Order(order_key.clone()), None, vec![])
            .await?;
        let subscription_id = uuid(&order["subscription_id"])?.to_owned();
        let checkout_id = uuid(&order["checkout_id"])?.to_owned();
        if order["id"] != order_key || original["sourceSubscriptionId"] == subscription_id {
            return Err(Error("BILLING_REPLACEMENT_IDENTITY_MISMATCH"));
        }
        // Both reads are dispatched, matching the owning Promise.all boundary.
        let (subscription, checkout) = tokio::join!(
            self.client.request(
                Operation::Subscription(subscription_id.clone()),
                None,
                vec![]
            ),
            self.client
                .request(Operation::ReadCheckout(checkout_id.clone()), None, vec![])
        );
        let subscription = subscription?;
        let checkout = checkout?;
        let snapshot = provider::snapshot(
            &self.client.config,
            string(&identity["workspaceId"])?,
            &subscription_id,
            &subscription,
        )?;
        let paid_at = date(&snapshot["currentPeriodStart"])?;
        let now = (self.clock)();
        let mut schedule_input = original.clone();
        schedule_input["paidAt"] = json!(stamp(paid_at));
        let mut schedule = calendar::evaluate("replacement", &schedule_input)?;
        let original_end = calendar::next_month(paid_at, paid_at.day())?;
        let product = &self.client.config.paid_products[string(&original["renewalPlan"])?]
            [string(&original["targetCurrency"])?];
        let updated = date(&snapshot["updatedAt"])?;
        let period_end = date(&snapshot["currentPeriodEnd"])?;
        let next = date(&original["nextRenewalAt"])?;
        if snapshot["plan"] != original["renewalPlan"]
            || snapshot["status"] != "active"
            || snapshot["cancelAtPeriodEnd"] == true
            || !snapshot["terminatedAt"].is_null()
            || !snapshot["unsupportedPauseAt"].is_null()
            || [
                "resumes_at",
                "ends_at",
                "ended_at",
                "pending_update",
                "trial_start",
                "trial_end",
            ]
            .iter()
            .any(|k| !explicit_null(&subscription, k))
            || subscription["amount"] != original["renewalPriceMinor"]
            || subscription["seats"] != original["renewalMembers"]
            || paid_at > now
            || updated < paid_at
            || updated > now
            || next <= now
            || ![original_end, next].contains(&period_end)
        {
            return Err(refused());
        }
        if checkout.is_null() {
            return Err(invalid());
        }
        if checkout["id"] != checkout_id
            || checkout["status"] != "succeeded"
            || checkout["external_customer_id"] != identity["externalCustomerId"]
            || (!explicit_null(&checkout, "subscription_id")
                && checkout["subscription_id"] != subscription_id)
        {
            return Err(refused());
        }
        let metadata = checkout
            .get("metadata")
            .filter(|v| !v.is_null())
            .ok_or_else(invalid)?;
        if metadata["currency_change_request_id"] != request
            || metadata["workspace_id"] != identity["workspaceId"]
            || metadata["source_subscription_id"] != original["sourceSubscriptionId"]
            || checkout["product_id"] != *product
            || checkout["currency"] != original["targetCurrency"]
        {
            return Err(refused());
        }
        if billing::country(&checkout["customer_billing_address"]["country"])?["currency"]
            != original["targetCurrency"]
            || checkout["seats"] != original["renewalMembers"]
            || checkout["amount"] != original["renewalPriceMinor"]
            || checkout["net_amount"] != original["renewalPriceMinor"]
            || checkout["discount_amount"].as_f64() != Some(0.)
            || checkout["tax_behavior"] != "exclusive"
            || checkout["allow_trial"] != false
            || !explicit_null(&checkout, "trial_end")
        {
            return Err(refused());
        }
        let checkout_created = instant(&checkout["created_at"])?;
        if checkout_created > paid_at
            || instant(&checkout["modified_at"])? < paid_at
            || instant(&checkout["modified_at"])? > now
        {
            return Err(refused());
        }
        let customer = order
            .get("customer")
            .filter(|v| !v.is_null())
            .ok_or_else(invalid)?;
        if customer["external_id"] != identity["externalCustomerId"]
            || order["product_id"] != *product
            || order["currency"] != original["targetCurrency"]
            || order["billing_reason"] != "subscription_create"
            || order["paid"] != true
            || order["status"] != "paid"
            || order["net_amount"] != original["renewalPriceMinor"]
            || !provider::orders::consistent_amounts(&order)
            || order["refunded_amount"].as_f64() != Some(0.)
            || order["refunded_tax_amount"].as_f64() != Some(0.)
        {
            return Err(refused());
        }
        if instant(&order["created_at"])? < checkout_created || instant(&order["created_at"])? > now
        {
            return Err(refused());
        }
        if [
            "net_amount",
            "tax_amount",
            "total_amount",
            "due_amount",
            "refunded_amount",
            "refunded_tax_amount",
        ]
        .iter()
        .any(|k| billing::safe_integer(&order[k], 0).is_err())
            || ["tax_amount", "total_amount"]
                .iter()
                .any(|k| billing::safe_integer(&checkout[k], 0).is_err())
            || order["net_amount"].as_f64().unwrap() + order["tax_amount"].as_f64().unwrap()
                != order["total_amount"].as_f64().unwrap()
            || order["tax_amount"] != checkout["tax_amount"]
            || order["total_amount"] != checkout["total_amount"]
        {
            return Err(refused());
        }
        let items = order["items"].as_array().ok_or_else(invalid)?;
        if items.is_empty() {
            return Err(refused());
        }
        let mut sum = 0.0;
        for item in items {
            if item.is_null() {
                return Err(invalid());
            }
            let amount = billing::safe_integer(&item["amount"], 0).map_err(|_| refused())?;
            if item["proration"] != false
                || instant(&item["start_timestamp"])? != paid_at
                || instant(&item["end_timestamp"])? != original_end
            {
                return Err(refused());
            }
            sum += amount as f64;
        }
        if !sum.is_finite()
            || sum.fract() != 0.
            || sum > billing::MAX_SAFE as f64
            || sum != order["net_amount"].as_f64().unwrap()
        {
            return Err(refused());
        }
        if context(&self.context.resolve(actor, &request).await?)? != original {
            return Err(Error("BILLING_REPLACEMENT_CONTEXT_CHANGED"));
        }
        for (key,value) in json!({"requestId":request,"checkoutId":checkout_id,"orderId":order_key,"replacementSubscriptionId":subscription_id,"originalPaidPeriodEnd":stamp(original_end),"expectedProviderPeriodEnd":stamp(period_end),"periodAdjustmentRequired":period_end!=next,"paymentVerified":true,"providerChangeScheduled":false,"requiresVerifiedSourceStop":true,"requiresAtomicCutover":true}).as_object().unwrap(){schedule[key]=value.clone();}
        Ok(schedule)
    }
}
