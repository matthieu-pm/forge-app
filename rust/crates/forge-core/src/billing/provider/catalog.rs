//! Verify the approved native-currency monthly seat catalogue before checkout.
use crate::billing::{Error, Result, invalid, schema, string};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn catalog(product: &Value, input: &Value) -> Result<Value> {
    let plan = schema("selfServePlan", input["plan"].clone())?;
    let currency = schema("currency", input["currency"].clone())?;
    if product.is_null() {
        return Err(invalid());
    }
    let id = string(&input["productId"])?;
    if !crate::text::is_uuid(id) {
        return Err(invalid());
    }
    if product["id"] != id
        || product["is_archived"] != false
        || product["is_recurring"] != true
        || product["recurring_interval"] != "month"
        || product["recurring_interval_count"].as_f64() != Some(1.)
    {
        return Err(Error("BILLING_CATALOG_PRODUCT_MISMATCH"));
    }
    let prices = product["prices"].as_array().ok_or_else(invalid)?;
    // The source filter accesses every element before checking any active price.
    if prices.iter().any(Value::is_null) {
        return Err(invalid());
    }
    let prices: Vec<_> = prices
        .iter()
        .filter(|price| price["is_archived"] == false)
        .collect();
    let unit_price = if plan == "starter" { 1000 } else { 1600 };
    let mut currencies = HashSet::new();
    for price in &prices {
        let mismatch = || Error("BILLING_CATALOG_PRICE_MISMATCH");
        let price_currency = price["price_currency"].as_str().ok_or_else(mismatch)?;
        if !["eur", "usd"].contains(&price_currency)
            || currencies.contains(price_currency)
            || price["amount_type"] != "seat_based"
            || price["source"] != "catalog"
            || price["product_id"] != product["id"]
            || price["tax_behavior"] != "exclusive"
        {
            return Err(mismatch());
        }
        let seats = price
            .get("seat_tiers")
            .filter(|v| !v.is_null())
            .ok_or_else(invalid)?;
        if seats["minimum_seats"].as_f64() != Some(1.)
            // Missing maximum is not the provider's explicit unbounded null.
            || seats.get("maximum_seats") != Some(&Value::Null)
        {
            return Err(mismatch());
        }
        let tiers = seats
            .get("tiers")
            .filter(|v| !v.is_null())
            .ok_or_else(invalid)?;
        let length = match tiers {
            Value::Array(values) => Some(values.len()),
            Value::String(value) => Some(value.encode_utf16().count()),
            _ => tiers
                .get("length")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok()),
        };
        if length != Some(1)
            || seats
                .get("seat_tier_type")
                .is_some_and(|v| v != "volume" && v != "graduated")
        {
            return Err(mismatch());
        }
        // A one-character string has a JS index 0, but no tier fields.
        if tiers.is_string() {
            return Err(mismatch());
        }
        let tier = match tiers {
            Value::Array(values) => values.first(),
            _ => tiers.get("0"),
        }
        .filter(|v| !v.is_null())
        .ok_or_else(invalid)?;
        if tier["min_seats"].as_f64() != Some(1.)
            || tier.get("max_seats").is_some_and(|v| !v.is_null())
            || tier["price_per_seat"].as_f64() != Some(f64::from(unit_price))
        {
            return Err(mismatch());
        }
        currencies.insert(price_currency);
    }
    let price = prices
        .iter()
        .find(|p| p["price_currency"] == currency)
        .ok_or(Error("BILLING_CATALOG_PRICE_MISMATCH"))?;
    let price_id = string(&price["id"])?;
    if !crate::text::is_uuid(price_id) {
        return Err(invalid());
    }
    Ok(
        json!({"productId":product["id"],"priceId":price_id,"currency":currency,"unitPriceMinor":unit_price,"taxBehavior":"exclusive"}),
    )
}
