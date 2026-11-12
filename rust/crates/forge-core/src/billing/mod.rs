//! Pure commercial policy. Provider payment proof and durable ledger mutations
//! belong to their adapters; these calculations never grant payment authority.
use serde_json::{Value, json};
use std::sync::LazyLock;
pub mod budget;
pub mod calendar;
pub mod configuration;
pub mod invoice;
pub mod management;
pub mod money;
pub mod projection;
pub mod usage;
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub &'static str);
pub type Result<T> = std::result::Result<T, Error>;
static POLICY: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/billing-policy.json"))
        .expect("source billing policy")
});
fn invalid() -> Error {
    Error("INVALID_BILLING_INPUT")
}
fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(invalid)
}
fn choice<'a>(value: &'a Value, choices: &[&str]) -> Result<&'a str> {
    let s = string(value)?;
    if choices.contains(&s) {
        Ok(s)
    } else {
        Err(invalid())
    }
}
pub fn safe_integer(value: &Value, minimum: u64) -> Result<u64> {
    let n = value.as_f64().ok_or_else(invalid)?;
    if !n.is_finite() || n.fract() != 0. || n < minimum as f64 || n > MAX_SAFE as f64 {
        return Err(invalid());
    }
    Ok(n as u64)
}
fn safe(value: u128) -> Result<u64> {
    if value > u128::from(MAX_SAFE) {
        Err(Error("BILLING_INTEGER_OVERFLOW"))
    } else {
        Ok(value as u64)
    }
}
pub fn schema(kind: &str, value: Value) -> Result<Value> {
    match kind {
        "selfServePlan" => {
            choice(&value, &["starter", "plus"])?;
        }
        "standardPlan" => {
            choice(&value, &["free", "starter", "plus"])?;
        }
        "billingPlan" => {
            choice(&value, &["free", "starter", "plus", "enterprise"])?;
        }
        "phase" => {
            choice(&value, &["standard", "trial"])?;
        }
        "currency" => {
            choice(&value, &["eur", "usd"])?;
        }
        "members" => return Ok(json!(safe_integer(&value, 1)?)),
        _ => return Err(invalid()),
    }
    Ok(value)
}
pub fn country(value: &Value) -> Result<Value> {
    let country = crate::text::trim(string(value)?).to_uppercase();
    if !POLICY["countries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == &country)
    {
        return Err(invalid());
    }
    let euro = POLICY["euroCountries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == &country);
    Ok(json!({"country":country,"currency":if euro{"eur"}else{"usd"}}))
}
pub fn identity(actor: &crate::actor::Actor) -> Result<Value> {
    if !matches!(
        actor.authentication,
        crate::actor::Authentication::Session { .. }
    ) || !actor
        .workspace_role
        .split(',')
        .map(crate::text::trim)
        .any(|s| ["owner", "admin"].contains(&s))
        || crate::text::trim(&actor.workspace_id).is_empty()
        || crate::text::trim(&actor.user_id).is_empty()
    {
        return Err(Error("FORBIDDEN"));
    }
    Ok(
        json!({"externalCustomerId":format!("forge:workspace:{}",actor.workspace_id),"workspaceId":actor.workspace_id,"actorUserId":actor.user_id}),
    )
}
pub fn charge(value: &Value) -> Result<bool> {
    let plan = choice(&value["plan"], &["free", "starter", "plus"])?;
    let phase = choice(&value["accessPhase"], &["standard", "trial"])?;
    if phase == "trial" && plan == "free" {
        return Err(invalid());
    }
    let feature = choice(&value["feature"], &["agent", "calls", "signals"])?;
    let mode = choice(
        &value["billingMode"],
        &[
            "forge-managed",
            "subscription",
            "token-plan",
            "pay-as-you-go",
        ],
    )?;
    Ok(mode == "forge-managed" && (plan == "free" || phase == "trial" || feature == "agent"))
}
/// Owned operation names are selected by the host. Inputs remain untrusted;
/// this boundary is shared by source parity fixtures and downstream adapters.
pub fn evaluate(kind: &str, value: &Value) -> Result<Value> {
    match kind {
        "schema" => schema(string(&value["schema"])?, value["value"].clone()),
        "country" => country(value),
        "identity" => identity(&serde_json::from_value(value.clone()).map_err(|_| invalid())?),
        "configuration" => {
            let env = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
            serde_json::to_value(configuration::read(&env)?).map_err(|_| invalid())
        }
        "capacity" => {
            let plan = schema("billingPlan", value["plan"].clone())?;
            let current = safe_integer(&value["currentMembers"], 0)?;
            let additional = match value.get("additionalMembers") {
                Some(v) => safe_integer(v, 1)?,
                None => 1,
            };
            let projected = safe(u128::from(current) + u128::from(additional))?;
            let limit = &POLICY["limits"][plan.as_str().unwrap()]["members"];
            Ok(
                json!({"allowed":limit.as_u64().is_none_or(|n|projected<=n),"memberLimit":limit,"projectedMembers":projected}),
            )
        }
        "upload" => {
            let plan = schema("billingPlan", value["plan"].clone())?;
            let size = safe_integer(&value["sizeBytes"], 1)?;
            let limit = &POLICY["limits"][plan.as_str().unwrap()]["uploadBytes"];
            Ok(json!({"allowed":limit.as_u64().is_none_or(|n|size<=n),"limitBytes":limit}))
        }
        "price" => {
            let plan = schema("selfServePlan", value["plan"].clone())?;
            let price = POLICY["monthlySeatPriceMinor"][plan.as_str().unwrap()]
                .as_u64()
                .unwrap();
            Ok(json!(safe(
                u128::from(price) * u128::from(safe_integer(&value["members"], 1)?)
            )?))
        }
        "pool" => Ok(json!(safe(
            u128::from(safe_integer(&value["perMemberLimit"], 0)?)
                * u128::from(safe_integer(&value["members"], 1)?)
        )?)),
        "charge" => Ok(json!({"usesWorkspaceAiPool":charge(value)?})),
        "cost" => Ok(json!(if charge(value)? {
            safe_integer(&value["providerCostMicros"], 0)?
        } else {
            0
        })),
        "next-month" | "anchor" | "replacement" | "period" | "trial-carryover"
        | "paid-carryover" => calendar::evaluate(kind, value),
        "authority" => usage::authority(value),
        "paid-binding" => Ok(json!(usage::paid_binding(value)?)),
        "notices" => usage::notices(value),
        "money-capacity" => money::capacity(value),
        "money-cost" => money::cost(value),
        "money-reserve" => money::reserve(value),
        "money-cutover" => money::cutover(value),
        "money-invoice" => invoice::monthly_report(value),
        "ai-allowance" => Ok(json!(budget::allowance(value)?)),
        "overage-policy" => {
            budget::overage(value)?;
            Ok(value.clone())
        }
        "budget-admission" => budget::admission(value),
        "polar-usage-ack" => Ok(json!(invoice::acknowledgement(value)?)),
        _ => Err(invalid()),
    }
}
