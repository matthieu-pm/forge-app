//! Refund allocation proof from freshly retrieved provider order data.
use super::{instant, orders::signed};
use crate::billing::{Error, Result, calendar::stamp, configuration::Enabled, safe_integer};
use serde_json::{Value, json};

fn uuid(value: &Value) -> Result<Value> {
    if !value.as_str().is_some_and(crate::text::is_uuid) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    Ok(value.clone())
}

pub fn verify(config: &Enabled, workspace: &str, order_id: &str, order: &Value) -> Result<Value> {
    if order.is_null() {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    if order["id"] != order_id {
        return Err(Error("BILLING_PROVIDER_IDENTITY_MISMATCH"));
    }
    if order.get("customer").is_none_or(Value::is_null) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    if order["customer"]["external_id"] != format!("forge:workspace:{workspace}") {
        return Err(Error("BILLING_PROVIDER_IDENTITY_MISMATCH"));
    }
    let mut matches = vec![];
    if let Some(products) = config.paid_products.as_object() {
        for (plan, prices) in products {
            if let Some(prices) = prices.as_object() {
                for (currency, id) in prices {
                    if order["currency"] == currency.as_str() && order["product_id"] == *id {
                        matches.push(plan.as_str());
                    }
                }
            }
        }
    }
    let upgrade =
        order["billing_reason"] == "subscription_update" && matches.first() == Some(&"plus");
    if matches.len() != 1
        || (!upgrade
            && !matches!(
                order["billing_reason"].as_str(),
                Some("subscription_create" | "subscription_cycle")
            ))
    {
        return Err(Error("BILLING_REFUND_SCOPE_REQUIRED"));
    }
    let net = safe_integer(&order["net_amount"], 0)?;
    let tax = safe_integer(&order["tax_amount"], 0)?;
    let refunded = safe_integer(&order["refunded_amount"], 0)?;
    let refunded_tax = safe_integer(&order["refunded_tax_amount"], 0)?;
    if net == 0
        || safe_integer(&order["total_amount"], 0)? as f64 != net as f64 + tax as f64
        || order["applied_balance_amount"].as_f64() != Some(0.0)
        || refunded > net
        || refunded_tax > tax
    {
        return Err(Error("BILLING_REFUND_AMOUNT_INVALID"));
    }
    let full = refunded == net && refunded_tax == tax;
    let refunded_total = refunded as f64 + refunded_tax as f64;
    if (full && order["status"] != "refunded")
        || (!full
            && (order["status"] != "partially_refunded"
                || refunded_total <= 0.0
                || refunded_total >= net as f64 + tax as f64))
    {
        return Err(Error("BILLING_REFUND_STATUS_INVALID"));
    }
    let items = order["items"]
        .as_array()
        .ok_or(Error("INVALID_BILLING_INPUT"))?;
    let first = items
        .first()
        .ok_or(Error("BILLING_REFUND_ALLOCATION_REQUIRED"))?;
    let start = instant(&first["start_timestamp"])?;
    let end = instant(&first["end_timestamp"])?;
    if start >= end {
        return Err(Error("BILLING_REFUND_PERIOD_INVALID"));
    }
    if upgrade {
        let mut subtotal = 0.0_f64;
        let mut taxes = 0.0_f64;
        for item in items {
            if item.is_null() {
                return Err(Error("INVALID_BILLING_INPUT"));
            }
            if item["proration"] != true {
                return Err(Error("BILLING_REFUND_ALLOCATION_REQUIRED"));
            }
            let (Some(amount), Some(tax_amount)) =
                (signed(&item["amount"]), signed(&item["tax_amount"]))
            else {
                return Err(Error("BILLING_REFUND_ALLOCATION_REQUIRED"));
            };
            if instant(&item["start_timestamp"])? != start
                || instant(&item["end_timestamp"])? != end
            {
                return Err(Error("BILLING_REFUND_ALLOCATION_REQUIRED"));
            }
            subtotal += amount;
            taxes += tax_amount;
        }
        if subtotal < net as f64 || taxes != tax as f64 {
            return Err(Error("BILLING_REFUND_ALLOCATION_REQUIRED"));
        }
    } else if items.len() != 1
        || first["proration"] != false
        || safe_integer(&first["amount"], 0)? < net
        || safe_integer(&first["tax_amount"], 0)? != tax
    {
        return Err(Error("BILLING_REFUND_ALLOCATION_REQUIRED"));
    }
    Ok(
        json!({"kind":if full{"full"}else{"partial"},"scope":if upgrade{"upgrade"}else{"period"},"workspaceId":workspace,"environment":config.environment,"orderId":uuid(&json!(order_id))?,"subscriptionId":uuid(&order["subscription_id"] )?,"start":stamp(start),"end":stamp(end),"refundedAt":stamp(instant(&order["modified_at"] )?)}),
    )
}
