use forge_core::billing;
use serde_json::Value;
use std::sync::LazyLock;
static FIXTURES: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../data/billing-reference.json")).unwrap());
fn check(kinds: &[&str]) {
    let mut count = 0;
    for (index, case) in FIXTURES["cases"].as_array().unwrap().iter().enumerate() {
        let kind = case["kind"].as_str().unwrap();
        if !kinds.contains(&kind) {
            continue;
        }
        count += 1;
        let result = billing::evaluate(kind, &case["input"]);
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {index}: {kind}, input {}, result {result:?}",
            case["input"]
        );
        if let Ok(value) = result {
            assert_eq!(
                value, case["output"],
                "case {index}: {kind}, input {}",
                case["input"]
            );
        }
    }
    assert!(count > 0);
}
#[test]
fn commercial_plans_prices_capacity_and_countries_match_owning_source() {
    check(&["schema", "capacity", "upload", "price", "pool", "country"]);
}
#[test]
fn billing_configuration_and_management_identity_match_source() {
    check(&["configuration", "identity"]);
}
#[test]
fn billable_usage_excludes_paid_calls_and_user_owned_provider_costs() {
    check(&["charge", "cost"]);
}
#[test]
fn monthly_anniversaries_preserve_original_days_times_and_half_open_windows() {
    check(&["next-month", "anchor", "replacement", "period"]);
}
#[test]
fn expiry_carryover_preserves_capacity_without_creating_a_new_charge_or_allowance() {
    check(&["trial-carryover", "paid-carryover"]);
}
#[test]
fn usage_authority_and_notices_share_live_payment_trial_grace_and_downgrade_rules() {
    check(&["authority", "paid-binding", "notices"]);
}
