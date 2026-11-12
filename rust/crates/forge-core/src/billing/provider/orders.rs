//! Paid invoice candidates. A provider status alone does not prove an upgrade.
use super::instant;
use crate::billing::{
    Error, MAX_SAFE, Result,
    calendar::{date, stamp},
};
use serde_json::{Value, json};

pub(super) fn signed(value: &Value) -> Option<f64> {
    let value = value.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE as f64).then_some(value)
}

fn cents(value: &Value) -> Option<u64> {
    signed(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value as u64)
}

/// `due_amount` is the original invoice total after balance, not unpaid debt.
pub fn consistent_amounts(order: &Value) -> bool {
    let Some(net) = cents(&order["net_amount"]) else {
        return false;
    };
    let Some(tax) = cents(&order["tax_amount"]) else {
        return false;
    };
    let Some(total) = cents(&order["total_amount"]) else {
        return false;
    };
    let Some(due) = cents(&order["due_amount"]) else {
        return false;
    };
    let Some(refunded) = cents(&order["refunded_amount"]) else {
        return false;
    };
    let Some(refunded_tax) = cents(&order["refunded_tax_amount"]) else {
        return false;
    };
    let Some(balance) = signed(&order["applied_balance_amount"]) else {
        return false;
    };
    u128::from(net) + u128::from(tax) == u128::from(total)
        && i128::from(due) == (i128::from(total) + balance as i128).max(0)
        && refunded <= net
        && refunded_tax <= tax
}

/// Return no proof for an ineligible candidate, preserving the owning selector.
pub fn upgrade(context: &Value, order: &Value) -> Result<Value> {
    // Missing/null nested records abort the source selector. Do not silently
    // continue to a later invoice after an unreadable provider candidate.
    if order.get("customer").is_none_or(Value::is_null) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    let customer = format!(
        "forge:workspace:{}",
        context["workspaceId"].as_str().unwrap_or_default()
    );
    if order["customer"]["external_id"] != customer
        || order["subscription_id"] != context["subscriptionId"]
        || order["product_id"] != context["productId"]
        || order["currency"] != context["currency"]
        || order["paid"] != true
        || !matches!(
            order["status"].as_str(),
            Some("paid" | "partially_refunded")
        )
        || !matches!(
            order["billing_reason"].as_str(),
            Some("subscription_update" | "subscription_cycle")
        )
        || !consistent_amounts(order)
    {
        return Ok(Value::Null);
    }
    let total = order["total_amount"].as_f64().expect("validated cents");
    let refunded = order["refunded_amount"].as_f64().expect("validated cents")
        + order["refunded_tax_amount"]
            .as_f64()
            .expect("validated cents");
    if (total == 0.0 && order["status"] != "paid") || (total > 0.0 && refunded >= total) {
        return Ok(Value::Null);
    }
    let (Ok(created), Some(id), Some(items)) = (
        instant(&order["created_at"]),
        order["id"].as_str(),
        order["items"].as_array(),
    ) else {
        return Ok(Value::Null);
    };
    let start = date(&context["periodStart"])?;
    let end = date(&context["periodEnd"])?;
    if !crate::text::is_uuid(id) || created < start || created >= end || items.is_empty() {
        return Ok(Value::Null);
    }
    // Source reduce accesses every item before deciding whether the subtotal
    // is valid, so a later null still aborts after an earlier invalid amount.
    if items.iter().any(Value::is_null) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    // The owning code sums with JS numbers and checks the final sum. Preserve
    // floating addition order, including signed proration credits/cancellation.
    let mut subtotal = 0.0_f64;
    for item in items {
        let Some(amount) = signed(&item["amount"]) else {
            return Ok(Value::Null);
        };
        subtotal += amount;
    }
    if !subtotal.is_finite()
        || subtotal.fract() != 0.0
        || subtotal.abs() > MAX_SAFE as f64
        || subtotal < order["net_amount"].as_f64().expect("validated cents")
    {
        return Ok(Value::Null);
    }
    for item in items {
        let (Ok(line_start), Ok(line_end), Some(proration)) = (
            instant(&item["start_timestamp"]),
            instant(&item["end_timestamp"]),
            item["proration"].as_bool(),
        ) else {
            return Ok(Value::Null);
        };
        if line_start >= line_end
            || line_end != end
            || if order["billing_reason"] == "subscription_update" {
                !proration || line_start < start
            } else {
                proration || line_start != start
            }
        {
            return Ok(Value::Null);
        }
    }
    Ok(
        json!({"orderId":order["id"],"subscriptionId":context["subscriptionId"],"periodStart":stamp(start),"periodEnd":stamp(end),"createdAt":stamp(created)}),
    )
}

/// Validate one candidate from the bounded Starter basis search.
pub fn starter_basis(context: &Value, order: &Value) -> Result<Value> {
    if order.is_null() {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    if !matches!(
        order["billing_reason"].as_str(),
        Some("subscription_create" | "subscription_cycle")
    ) {
        return Ok(Value::Null);
    }
    if order.get("items").is_none_or(Value::is_null) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    let Some(first) = order["items"].as_array().and_then(|items| items.first()) else {
        return Ok(Value::Null);
    };
    let Ok(start) = instant(&first["start_timestamp"]) else {
        return Ok(Value::Null);
    };
    if start > date(&context["upgradeStart"])? {
        return Ok(Value::Null);
    }
    let mut full_context = context.clone();
    full_context["periodStart"] = json!(stamp(start));
    let mut full_order = order.clone();
    full_order["billing_reason"] = json!("subscription_cycle");
    let proof = upgrade(&full_context, &full_order)?;
    Ok(if proof.is_null() {
        Value::Null
    } else {
        json!({"orderId":proof["orderId"],"start":proof["periodStart"],"end":proof["periodEnd"]})
    })
}
