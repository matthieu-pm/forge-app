//! Normalize a fresh provider observation; durable projection separately decides
//! whether the observation can change access or establish a paid activation.
use crate::billing::{
    Error, Result,
    calendar::{date, stamp},
    configuration::Enabled,
    invalid, money, string,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

fn instant(value: &Value) -> Result<DateTime<Utc>> {
    if !money::INSTANT.is_match(string(value)?) {
        return Err(invalid());
    }
    date(value).map_err(|_| invalid())
}
fn nullable_instant(value: &Value, key: &str) -> Result<Option<DateTime<Utc>>> {
    match value.get(key) {
        Some(Value::Null) => Ok(None),
        Some(value) => instant(value).map(Some),
        None => Err(invalid()),
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
pub fn snapshot(
    config: &Enabled,
    workspace: &str,
    subscription: &str,
    value: &Value,
) -> Result<Value> {
    if value.is_null() {
        return Err(invalid());
    }
    if value["id"] != subscription {
        return Err(Error("BILLING_PROVIDER_IDENTITY_MISMATCH"));
    }
    let customer = value
        .get("customer")
        .filter(|v| !v.is_null())
        .ok_or_else(invalid)?;
    if customer["external_id"] != format!("forge:workspace:{workspace}") {
        return Err(Error("BILLING_PROVIDER_IDENTITY_MISMATCH"));
    }
    let mut products = Vec::new();
    for (plan, prices) in config.paid_products.as_object().ok_or_else(invalid)? {
        for (currency, product) in prices.as_object().ok_or_else(invalid)? {
            if product == &value["product_id"] && value["currency"] == currency.as_str() {
                products.push(plan.as_str());
            }
        }
    }
    if products.len() != 1
        || value["recurring_interval"] != "month"
        || value["recurring_interval_count"].as_f64() != Some(1.)
    {
        return Err(Error("BILLING_PROVIDER_CATALOG_MISMATCH"));
    }
    let status = value["status"]
        .as_str()
        .filter(|status| ["active", "past_due", "canceled", "unpaid", "paused"].contains(status))
        .ok_or(Error("BILLING_LIFECYCLE_POLICY_REQUIRED"))?;
    let cancel = value["cancel_at_period_end"]
        .as_bool()
        .ok_or_else(invalid)?;
    let updated = instant(
        value
            .get("modified_at")
            .filter(|v| !v.is_null())
            .unwrap_or(&value["created_at"]),
    )?;
    let end = instant(&value["current_period_end"])?;
    let scheduled_pause = value["pause_at_period_end"].as_bool().ok_or_else(invalid)?;
    let paused = nullable_instant(value, "paused_at")?;
    let resumes = nullable_instant(value, "resumes_at")?;
    if status == "paused" && paused.is_none()
        || paused.is_some_and(|at| at > updated)
        || resumes.is_some_and(|at| {
            paused.is_none() && !scheduled_pause || paused.is_some_and(|paused| at <= paused)
        })
    {
        return Err(Error("BILLING_PAUSE_STATE_INVALID"));
    }
    let ended = if truthy(&value["ended_at"]) {
        Some(instant(&value["ended_at"])?)
    } else {
        None
    };
    let terminal = ["canceled", "unpaid"].contains(&status);
    if ended.is_some_and(|at| !terminal || at > updated) {
        return Err(Error("BILLING_TERMINATION_STATE_INVALID"));
    }
    let terminated = if terminal && (ended.is_some() || status == "unpaid" || !cancel) {
        Some(ended.unwrap_or(updated))
    } else {
        None
    };
    if terminated.is_none()
        && cancel
        && truthy(&value["ends_at"])
        && instant(&value["ends_at"])? != end
    {
        return Err(Error("BILLING_CANCELLATION_BOUNDARY_MISMATCH"));
    }
    let start = instant(&value["current_period_start"])?;
    let past_due = if status == "past_due" {
        Some(instant(&value["past_due_at"])?)
    } else {
        None
    };
    Ok(json!({
        "workspaceId":workspace,
        "environment":config.environment,
        "subscriptionId":subscription,
        "plan":if products[0] == "starter" { "starter" } else { "plus" },
        "status":match status { "unpaid"=>"canceled", "paused"=>"active", other=>other },
        "terminatedAt":terminated.map(stamp),
        "unsupportedPauseAt":paused.or(if scheduled_pause {Some(end)} else {None}).map(stamp),
        "updatedAt":stamp(updated),
        "currentPeriodStart":stamp(start),
        "currentPeriodEnd":stamp(end),
        "pastDueAt":past_due.map(stamp),
        "cancelAtPeriodEnd":terminated.is_none() && (cancel || status == "canceled"),
    }))
}
