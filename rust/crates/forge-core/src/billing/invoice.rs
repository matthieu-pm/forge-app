//! Cumulative invoice arithmetic over immutable usage-time conversions. No
//! provider delivery or payment authority is inferred from these calculations.
use super::*;
use num_bigint_dig::BigUint;
use num_integer::Integer;
use num_traits::{One, ToPrimitive, Zero};
use std::collections::HashSet;

pub fn monthly_report(value: &Value) -> Result<Value> {
    let currency = money::currency(&value["currency"])?;
    let previous = safe_integer(&value["previouslyReportedMinor"], 0)?;
    let rows = value["usage"].as_array().ok_or_else(invalid)?;
    if rows.len() > 10_000 {
        return Err(Error("BILLING_INVOICE_BATCH_TOO_LARGE"));
    }
    let mut ids = HashSet::new();
    let (mut numerator, mut denominator) = (BigUint::zero(), BigUint::one());
    for row in rows {
        let id = string(&row["usageId"])?;
        if !crate::text::is_uuid(id) {
            return Err(invalid());
        }
        if !ids.insert(id) {
            return Err(Error("BILLING_DUPLICATE_USAGE"));
        }
        let stored = &row["money"];
        if stored["currency"] != currency || stored["rounding"] != "settlement" {
            return Err(Error("BILLING_UNSETTLED_OR_MIXED_CURRENCY"));
        }
        let verified = money::cost(
            &json!({"currency":currency,"providerUsdMicros":stored["providerUsdMicros"],
            "incurredAt":stored["incurredAt"],"rate":stored["rate"],"rounding":"settlement"}),
        )?;
        if ["amountMicros", "exactNumerator", "exactDenominator"]
            .iter()
            .any(|key| verified[key] != stored[key])
        {
            return Err(Error("BILLING_CONVERSION_CHANGED"));
        }
        let n: BigUint = string(&verified["exactNumerator"])?
            .parse()
            .map_err(|_| invalid())?;
        let d: BigUint = string(&verified["exactDenominator"])?
            .parse()
            .map_err(|_| invalid())?;
        let common = denominator.gcd(&d);
        numerator = numerator * (&d / &common) + n * (&denominator / &common);
        denominator *= d / common;
        let reduction = numerator.gcd(&denominator);
        numerator /= &reduction;
        denominator /= reduction;
        if denominator.to_string().len() > 1000 {
            return Err(Error("BILLING_INVOICE_PRECISION_LIMIT"));
        }
    }
    let minor_denominator = &denominator * BigUint::from(10_000_u32);
    let total = ((&numerator * BigUint::from(2_u32) + &minor_denominator)
        / (&minor_denominator * BigUint::from(2_u32)))
    .to_u64()
    .filter(|n| *n <= MAX_SAFE)
    .ok_or(Error("BILLING_INVOICE_OVERFLOW"))?;
    if total < previous {
        return Err(Error("BILLING_CREDIT_RECONCILIATION_REQUIRED"));
    }
    Ok(
        json!({"currency":currency,"totalMinor":total,"previouslyReportedMinor":previous,"reportableMinor":total-previous,
        "exactCurrencyMicrosNumerator":numerator.to_string(),"exactCurrencyMicrosDenominator":denominator.to_string(),"usageCount":ids.len()}),
    )
}
pub fn acknowledgement(value: &Value) -> Result<&'static str> {
    let inserted = safe_integer(&value["inserted"], 0)?;
    let duplicates = value
        .get("duplicates")
        .map(|n| safe_integer(n, 0))
        .transpose()?
        .unwrap_or(0);
    if inserted > 1 || duplicates > 1 || inserted + duplicates != 1 {
        return Err(Error("POLAR_USAGE_ACKNOWLEDGEMENT_INCOMPLETE"));
    }
    Ok(if inserted == 1 {
        "inserted"
    } else {
        "duplicate"
    })
}
