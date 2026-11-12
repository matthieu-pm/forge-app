//! Prepared plan changes preserve paid-period and renewal-quantity boundaries.
//! Provider effects remain outside SQL transactions and require a fresh read on retry.
use super::{
    Client, Clock, Error, ManagementContext, Subscriptions, coerce_date,
    reconciliation::SnapshotSink,
    seats::{self, same, truthy},
};
use async_trait::async_trait;
use forge_core::{actor::Actor, billing};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub struct Changer {
    pub client: Arc<Client>,
    pub subscriptions: Arc<dyn Subscriptions>,
    pub context: Arc<dyn ManagementContext>,
    pub sink: Arc<dyn SnapshotSink>,
    pub clock: Clock,
}
struct Guarded {
    client: Arc<Client>,
    subscriptions: Arc<dyn Subscriptions>,
    resolver: Arc<dyn ManagementContext>,
    sink: Arc<dyn SnapshotSink>,
    actor: Actor,
    id: String,
    target: String,
    current_context: Mutex<Value>,
}
fn check_context(value: &Value, actor: &Actor, id: &str, selected: &str) -> Result<(), Error> {
    if value["workspaceId"] != actor.workspace_id || value["subscriptionId"] != id {
        return Err(Error("BILLING_SUBSCRIPTION_CONFLICT"));
    }
    billing::safe_integer(&value["billableMembers"], 1)?;
    billing::schema("selfServePlan", value["projectedPlan"].clone())?;
    if selected == "plus" && truthy(&value["refundedUpgrade"]) {
        return Err(Error("BILLING_REFUNDED_UPGRADE_REPURCHASE_REQUIRED"));
    }
    Ok(())
}
impl Guarded {
    async fn refresh(&self) -> Result<Value, Error> {
        let value = self.resolver.resolve(&self.actor).await?;
        check_context(&value, &self.actor, &self.id, &self.target)?;
        *self.current_context.lock().unwrap() = value.clone();
        Ok(value)
    }
}
#[async_trait]
impl ManagementContext for Guarded {
    async fn resolve(&self, _actor: &Actor) -> Result<Value, Error> {
        self.refresh().await
    }
}
#[async_trait]
impl Subscriptions for Guarded {
    async fn get(&self, id: &str) -> Result<Value, Error> {
        if id != self.id {
            return Err(Error("BILLING_SUBSCRIPTION_CONFLICT"));
        }
        let current = self.subscriptions.get(id).await?;
        let snapshot = billing::provider::snapshot(
            &self.client.config,
            &self.actor.workspace_id,
            id,
            &current,
        )?;
        if !snapshot["terminatedAt"].is_null() || !snapshot["unsupportedPauseAt"].is_null() {
            let event_id = format!(
                "forge.plan.restricted.{id}.{}",
                snapshot["updatedAt"].as_str().expect("snapshot timestamp")
            );
            self.sink.apply(json!({"eventId":event_id,"bodyHash":super::hash_bytes(event_id.as_bytes()),"snapshot":snapshot,"actor":self.actor})).await?;
            return Err(Error(if !snapshot["terminatedAt"].is_null() {
                "BILLING_SUBSCRIPTION_TERMINATED"
            } else {
                "BILLING_SUBSCRIPTION_PAUSE_UNSUPPORTED"
            }));
        }
        Ok(current)
    }
    async fn update(&self, id: &str, body: Value) -> Result<Value, Error> {
        let context = self.refresh().await?;
        if id != self.id
            || (body.get("seats").is_some()
                && !same(body.get("seats"), context.get("billableMembers")))
        {
            return Err(Error("BILLING_CONTEXT_CHANGED"));
        }
        self.subscriptions.update(id, body).await
    }
}
struct Validated {
    snapshot: Value,
    seats: u64,
    period: Value,
    currency: String,
}
impl Changer {
    fn validate(&self, actor: &Actor, id: &str, current: &Value) -> Result<Validated, Error> {
        let snapshot =
            billing::provider::snapshot(&self.client.config, &actor.workspace_id, id, current)?;
        let seats = billing::safe_integer(&current["seats"], 1)?;
        let period = seats::period(
            &actor.workspace_id,
            (self.clock)(),
            snapshot.get("currentPeriodStart"),
            snapshot.get("currentPeriodEnd"),
        )?;
        let currency = billing::schema("currency", current["currency"].clone())?;
        let currency = currency.as_str().expect("validated currency");
        let pending = &current["pending_update"];
        if truthy(pending)
            && (pending.get("units") != Some(&Value::Null)
                || coerce_date(pending.get("applies_at")) != coerce_date(period.get("end"))
                || (pending.get("product_id") != Some(&Value::Null)
                    && !(snapshot["plan"] == "plus"
                        && pending["product_id"]
                            == self.client.config.paid_products["starter"][currency]))
                || (pending.get("seats") == Some(&Value::Null)
                    && pending.get("product_id") == Some(&Value::Null)))
        {
            return Err(Error("BILLING_PENDING_CHANGE_CONFLICT"));
        }
        if let Some(value) = pending.get("seats").filter(|v| !v.is_null()) {
            billing::safe_integer(value, 1)?;
        }
        Ok(Validated {
            snapshot,
            seats,
            period,
            currency: currency.into(),
        })
    }
    pub async fn change(&self, actor: &Actor, target: &str) -> Result<Value, Error> {
        billing::identity(actor)?;
        billing::schema("selfServePlan", json!(target))?;
        let context = self.context.resolve(actor).await?;
        let id = super::uuid(&context["subscriptionId"])?.to_owned();
        check_context(&context, actor, &id, target)?;
        let guarded = Arc::new(Guarded {
            client: self.client.clone(),
            subscriptions: self.subscriptions.clone(),
            resolver: self.context.clone(),
            sink: self.sink.clone(),
            actor: actor.clone(),
            id: id.clone(),
            target: target.into(),
            current_context: Mutex::new(context),
        });
        let mut current = guarded.get(&id).await?;
        let before = self.validate(actor, &id, &current)?;
        let billed_amount = current.get("amount").cloned();
        if truthy(&current["cancel_at_period_end"])
            || truthy(&current["pause_at_period_end"])
            || ["paused_at", "ends_at", "ended_at"]
                .iter()
                .any(|key| current.get(*key) != Some(&Value::Null))
            || (current["status"] != "active"
                && !(current["status"] == "past_due"
                    && before.snapshot["plan"] == "plus"
                    && target == "plus"))
        {
            return Err(Error("BILLING_SUBSCRIPTION_NOT_RENEWING"));
        }
        let mut changed = false;
        let mut cleared = false;
        if current["status"] == "active" {
            if before.snapshot["plan"] != target
                && !(target == "starter"
                    && current["pending_update"]["product_id"]
                        == self.client.config.paid_products["starter"][&before.currency])
            {
                guarded.update(&id, json!({"product_id":self.client.config.paid_products[target][&before.currency],"proration_behavior":if target == "plus" { "invoice" } else { "next_period" }})).await?;
                changed = true;
                current = guarded.get(&id).await?;
            } else if before.snapshot["plan"] == target
                && truthy(&current["pending_update"]["product_id"])
            {
                guarded.update(&id, json!({"pending_update":null})).await?;
                cleared = true;
                current = guarded.get(&id).await?;
            }
        }
        let mut after = self.validate(actor, &id, &current)?;
        let expected_plan = if target == "plus" {
            "plus"
        } else {
            before.snapshot["plan"].as_str().expect("validated plan")
        };
        let same_window = |after: &Validated| {
            after.period["key"] == before.period["key"]
                && after.currency == before.currency
                && after.seats == before.seats
        };
        if !same_window(&after)
            || (after.snapshot["plan"] == before.snapshot["plan"]
                && !same(current.get("amount"), billed_amount.as_ref()))
            || (target == "plus" && after.snapshot["plan"] != "plus")
            || (target == "starter"
                && before.snapshot["plan"] == "plus"
                && (after.snapshot["plan"] != "plus"
                    || current["pending_update"]["product_id"]
                        != self.client.config.paid_products["starter"][&before.currency]
                    || !same(current.get("amount"), billed_amount.as_ref())))
        {
            return Err(Error("BILLING_PLAN_CHANGE_RECONCILIATION_REQUIRED"));
        }
        if current["status"] == "active" {
            guarded.refresh().await?;
            seats::Scheduler {
                client: self.client.clone(),
                subscriptions: guarded.clone(),
                context: guarded.clone(),
                clock: self.clock.clone(),
            }
            .schedule(actor)
            .await?;
            current = guarded.get(&id).await?;
            after = self.validate(actor, &id, &current)?;
            let context = guarded.current_context.lock().unwrap().clone();
            let renewal_seats = current["pending_update"]
                .get("seats")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(after.seats));
            if !same_window(&after)
                || after.snapshot["plan"] != expected_plan
                || (after.snapshot["plan"] == before.snapshot["plan"]
                    && !same(current.get("amount"), billed_amount.as_ref()))
                || !same(Some(&renewal_seats), context.get("billableMembers"))
                || (target == "starter"
                    && before.snapshot["plan"] == "plus"
                    && current["pending_update"]["product_id"]
                        != self.client.config.paid_products["starter"][&before.currency])
            {
                return Err(Error("BILLING_PLAN_CHANGE_RECONCILIATION_REQUIRED"));
            }
        }
        let mut snapshot = after.snapshot;
        if snapshot["plan"] == "plus" && snapshot["status"] == "active" {
            let proof = self.client.find_paid_upgrade(&json!({"workspaceId":actor.workspace_id,"subscriptionId":id,"productId":current["product_id"],"currency":current["currency"],"periodStart":snapshot["currentPeriodStart"],"periodEnd":snapshot["currentPeriodEnd"]})).await?;
            if !proof.is_null() {
                snapshot["paidUpgrade"] = proof;
            }
        }
        let context = guarded.current_context.lock().unwrap().clone();
        let pending_payment = target == "plus"
            && context["projectedPlan"] == "starter"
            && (snapshot["paidUpgrade"].is_null() || snapshot["status"] != "active");
        let status = if pending_payment {
            "payment-pending"
        } else if target == "starter" && snapshot["plan"] == "plus" {
            "scheduled"
        } else if cleared {
            "cleared"
        } else if changed {
            "applied"
        } else {
            "unchanged"
        };
        let command = json!({"target":target,"status":status,"effectiveAt":if status == "payment-pending" { Value::Null } else if status == "scheduled" { after.period["end"].clone() } else { snapshot["updatedAt"].clone() },"renewalSeats":context["billableMembers"]});
        let event_id = format!(
            "forge.plan.{id}.{target}.{status}.{}.{}.{}",
            snapshot["updatedAt"].as_str().expect("snapshot timestamp"),
            billing::safe_integer(&context["billableMembers"], 1)?,
            snapshot["paidUpgrade"]["orderId"]
                .as_str()
                .unwrap_or("none")
        );
        let hash_input = json!({"workspaceId":actor.workspace_id,"subscriptionId":id,"target":command["target"],"status":command["status"],"effectiveAt":command["effectiveAt"],"renewalSeats":command["renewalSeats"]});
        let result = self.sink.apply(json!({"eventId":event_id,"bodyHash":super::hash(&hash_input),"snapshot":snapshot,"actor":actor,"planChange":command})).await?;
        if result.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if result["outcome"] == "stale" {
            return Err(Error("BILLING_PLAN_CHANGE_RECONCILIATION_REQUIRED"));
        }
        let held = target == "plus" && result["effectivePlan"] != "business";
        let mut output = command;
        if held {
            output["status"] = json!("payment-pending");
            output["effectiveAt"] = Value::Null;
        }
        output["billedSeats"] = json!(after.seats);
        Ok(output)
    }
}
