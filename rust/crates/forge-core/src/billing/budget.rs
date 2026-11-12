//! Pure admission policy. The caller must bind trusted payment authority and
//! atomically reserve capacity under the durable workspace ledger lock.
use super::*;

pub(super) struct Cap<'a> {
    pub currency: &'a str,
    pub micros: u64,
}
pub(super) fn overage(value: &Value) -> Result<Option<Cap<'_>>> {
    let object = value.as_object().ok_or_else(invalid)?;
    match value["enabled"].as_bool().ok_or_else(invalid)? {
        false if object.len() == 1 => Ok(None),
        true if object.len() == 3 => Ok(Some(Cap {
            currency: money::currency(&value["currency"])?,
            micros: safe_integer(&value["monthlyCapMicros"], 0)?,
        })),
        _ => Err(invalid()),
    }
}
pub fn allowance(value: &Value) -> Result<u64> {
    let plan = choice(&value["plan"], &["free", "starter", "plus"])?;
    let phase = choice(&value["accessPhase"], &["standard", "trial"])?;
    if phase == "trial" && plan == "free" {
        return Err(invalid());
    }
    let members = safe_integer(&value["activeMembers"], 1)?;
    if plan == "free" || phase == "trial" {
        Ok(5_000_000)
    } else {
        safe(u128::from(members) * 5_000_000)
    }
}
pub fn admission(value: &Value) -> Result<Value> {
    let plan = choice(&value["plan"], &["free", "starter", "plus"])?;
    let uses_pool = charge(value)?;
    let phase = choice(&value["accessPhase"], &["standard", "trial"])?;
    let included = allowance(value)?;
    let policy = overage(&value["overage"])?;
    let authorized = value["paidOverageAuthorized"]
        .as_bool()
        .ok_or_else(invalid)?;
    let currency = money::currency(&value["billingCurrency"])?;
    let eligible =
        uses_pool && plan != "free" && phase != "trial" && policy.is_some() && authorized;
    if eligible && policy.as_ref().is_some_and(|p| p.currency != currency) {
        return Err(Error("BILLING_OVERAGE_CURRENCY_MISMATCH"));
    }
    let committed = safe(
        u128::from(safe_integer(&value["settledCostMicros"], 0)?)
            + u128::from(safe_integer(&value["reservedCostMicros"], 0)?),
    )?;
    let requested = safe_integer(&value["requestedReservationMicros"], 0)?;
    let allowance_reservation = if uses_pool { requested } else { 0 };
    let projected = safe(u128::from(committed) + u128::from(allowance_reservation))?;
    let requested_overage = allowance_reservation.min(projected.saturating_sub(included));
    let cap_micros = if eligible {
        policy.as_ref().unwrap().micros
    } else {
        0
    };
    let cap = money::reserve(&json!({"currency":currency,"capMicros":cap_micros,
        "settledMicros":value["settledOverageMicros"],"reservedMicros":value["reservedOverageMicros"],
        "requestedUsdMicros":if eligible { requested_overage } else { 0 },
        "incurredAt":value["incurredAt"],"rate":value["rate"]}))?;
    let within_pool = committed < included && projected <= included;
    let allowed = !uses_pool || within_pool || (eligible && cap["allowed"] == true);
    let usable = if eligible && currency == "eur" {
        None
    } else {
        Some(cap_micros)
    };
    let limit = usable
        .map(|n| safe(u128::from(included) + u128::from(n)))
        .transpose()?;
    Ok(
        json!({"allowed":allowed,"usesWorkspaceAiPool":uses_pool,"allowanceReservationMicros":allowance_reservation,
        "includedMicros":included,"usableOverageMicros":usable,"totalLimitMicros":limit,
        "projectedMicros":projected,"remainingMicros":limit.map(|n| n.saturating_sub(committed)),
        "costCurrency":"usd","overageCurrency":currency,"overageRemainingMicros":cap["remainingMicros"],
        "billingOverageReservation":if allowed && requested_overage > 0 && eligible { cap["reservation"].clone() } else { Value::Null },
        "requestedOverageMicros":if allowed { requested_overage } else { 0 }}),
    )
}
