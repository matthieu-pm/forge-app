//! Integer currency arithmetic. Quotes are frozen at usage time; conversions
//! retain their exact fractions independently of the rounded capacity amount.
use super::{
    calendar::{date, stamp},
    *,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use regex::Regex;

pub const ECB_REFERENCE_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
static DECIMAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,8})?$").unwrap());
static DAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());
pub(super) static INSTANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$").unwrap()
});

pub(super) fn currency(value: &Value) -> Result<&str> {
    choice(value, &["eur", "usd"])
}
pub(super) fn amount(value: u128) -> Result<u64> {
    if value > u128::from(MAX_SAFE) {
        Err(Error("BILLING_MONEY_OVERFLOW"))
    } else {
        Ok(value as u64)
    }
}
fn quote(value: &Value, at: DateTime<Utc>) -> Result<(u128, u128)> {
    let object = value.as_object().ok_or_else(invalid)?;
    let keys = [
        "id",
        "source",
        "sourceUrl",
        "referenceDate",
        "observedAt",
        "usdPerEur",
    ];
    if object.len() != keys.len() || object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(invalid());
    }
    let id = string(&value["id"])?;
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || value["source"] != "ecb-daily-reference"
        || value["sourceUrl"] != ECB_REFERENCE_URL
    {
        return Err(invalid());
    }
    let reference = string(&value["referenceDate"])?;
    let observed = string(&value["observedAt"])?;
    if !DAY.is_match(reference) || !INSTANT.is_match(observed) {
        return Err(invalid());
    }
    let reference = NaiveDate::parse_from_str(reference, "%Y-%m-%d")
        .map_err(|_| invalid())?
        .and_hms_opt(0, 0, 0)
        .ok_or_else(invalid)?
        .and_utc();
    // The source validator requires RFC 3339 seconds for qualified timestamps.
    // Keep the exact original snapshot bytes in the conversion evidence.
    let observed = date(&json!(observed))?;
    if observed > at || reference > observed || at - reference > Duration::days(7) {
        return Err(Error("BILLING_FX_RATE_UNAVAILABLE_FOR_USAGE"));
    }
    let decimal = string(&value["usdPerEur"])?;
    if !DECIMAL.is_match(decimal) {
        return Err(invalid());
    }
    let (whole, fractional) = decimal.split_once('.').unwrap_or((decimal, ""));
    let scale = 10_u128.pow(fractional.len() as u32);
    let units = whole.parse::<u128>().map_err(|_| invalid())? * scale
        + if fractional.is_empty() {
            0
        } else {
            fractional.parse::<u128>().map_err(|_| invalid())?
        };
    if units == 0 {
        return Err(Error("BILLING_FX_RATE_INVALID"));
    }
    Ok((units, scale))
}

pub fn capacity(value: &Value) -> Result<Value> {
    let from = currency(&value["fromCurrency"])?;
    let target = currency(&value["targetCurrency"])?;
    let original = safe_integer(&value["amountMicros"], 0)?;
    let at = date(&value["at"])?;
    let rounding = choice(&value["rounding"], &["down", "up"])?;
    let (mut numerator, mut denominator) = (u128::from(original), 1_u128);
    let mut rate = Value::Null;
    if from != target && original > 0 {
        let (units, scale) = quote(&value["rate"], at)?;
        numerator *= if from == "usd" { scale } else { units };
        denominator = if from == "usd" { units } else { scale };
        rate = value["rate"].clone();
    }
    let converted = amount(if rounding == "down" {
        numerator / denominator
    } else {
        numerator.div_ceil(denominator)
    })?;
    Ok(
        json!({"fromCurrency":from,"targetCurrency":target,"originalMicros":original,
        "amountMicros":converted,"at":stamp(at),"rate":rate,"rounding":rounding,
        "exactNumerator":numerator.to_string(),"exactDenominator":denominator.to_string()}),
    )
}
pub fn cost(value: &Value) -> Result<Value> {
    let currency = currency(&value["currency"])?;
    let usd = safe_integer(&value["providerUsdMicros"], 0)?;
    let at = date(&value["incurredAt"])?;
    let rounding = choice(&value["rounding"], &["reservation", "settlement"])?;
    let (mut numerator, mut denominator) = (u128::from(usd), 1_u128);
    let mut rate = Value::Null;
    if currency == "eur" && usd > 0 {
        let (units, scale) = quote(&value["rate"], at)?;
        numerator *= scale;
        denominator = units;
        rate = value["rate"].clone();
    }
    let converted = amount(if rounding == "reservation" {
        numerator.div_ceil(denominator)
    } else {
        (2 * numerator + denominator) / (2 * denominator)
    })?;
    Ok(
        json!({"currency":currency,"providerUsdMicros":usd,"amountMicros":converted,
        "incurredAt":stamp(at),"rate":rate,"rounding":rounding,
        "exactNumerator":numerator.to_string(),"exactDenominator":denominator.to_string()}),
    )
}
pub fn reserve(value: &Value) -> Result<Value> {
    let cap = safe_integer(&value["capMicros"], 0)?;
    let committed = u128::from(safe_integer(&value["settledMicros"], 0)?)
        + u128::from(safe_integer(&value["reservedMicros"], 0)?);
    let reservation = cost(
        &json!({"currency":value["currency"],"providerUsdMicros":value["requestedUsdMicros"],
        "incurredAt":value["incurredAt"],"rate":value["rate"],"rounding":"reservation"}),
    )?;
    let projected = committed + u128::from(safe_integer(&reservation["amountMicros"], 0)?);
    let cap = u128::from(cap);
    Ok(
        json!({"allowed":committed < cap && projected <= cap,"committedMicros":amount(committed)?,
        "projectedMicros":amount(projected)?,"remainingMicros":amount(cap.saturating_sub(committed))?,"reservation":reservation}),
    )
}
/// Capacity shadows keep original charges immutable and grant no authority.
pub fn cutover(value: &Value) -> Result<Value> {
    let from = currency(&value["fromCurrency"])?;
    let target = currency(&value["targetCurrency"])?;
    let policy = budget::overage(&value["policy"])?;
    let settled = safe_integer(&value["settledMicros"], 0)?;
    let reserved = safe_integer(&value["reservedMicros"], 0)?;
    let start = date(&value["periodStart"])?;
    let end = date(&value["periodEnd"])?;
    let at = date(&value["cutoverAt"])?;
    if start > at || at >= end {
        return Err(Error("BILLING_CURRENCY_CUTOVER_OUTSIDE_PERIOD"));
    }
    if policy.as_ref().is_some_and(|p| p.currency != from) {
        return Err(Error("BILLING_OVERAGE_CURRENCY_MISMATCH"));
    }
    let convert = |micros, rounding| {
        capacity(&json!({"fromCurrency":from,"targetCurrency":target,
        "amountMicros":micros,"rounding":rounding,"at":stamp(at),"rate":value["rate"]}))
    };
    let cap = policy.map(|p| convert(p.micros, "down")).transpose()?;
    let settled = convert(settled, "up")?;
    let reserved = convert(reserved, "up")?;
    let committed = amount(
        u128::from(safe_integer(&settled["amountMicros"], 0)?)
            + u128::from(safe_integer(&reserved["amountMicros"], 0)?),
    )?;
    let cap_micros = cap
        .as_ref()
        .map(|c| safe_integer(&c["amountMicros"], 0))
        .transpose()?
        .unwrap_or(0);
    let policy = if cap.is_some() {
        json!({"enabled":true,"currency":target,"monthlyCapMicros":cap_micros})
    } else {
        json!({"enabled":false})
    };
    Ok(
        json!({"fromCurrency":from,"targetCurrency":target,"periodStart":stamp(start),"periodEnd":stamp(end),
        "cutoverAt":stamp(at),"policy":policy,"cap":cap,"settledCapacity":settled,"reservedCapacity":reserved,
        "committedCapacityMicros":committed,"remainingCapacityMicros":cap_micros.saturating_sub(committed),
        "grantsPaymentAuthority":false,"rewritesHistoricalCharges":false}),
    )
}
