use forge_core::billing;
use serde_json::{Value, json};
use std::sync::LazyLock;
static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/billing-money-reference.json")).unwrap()
});
fn check(kinds: &[&str]) {
    let mut count = 0;
    let mut failures = Vec::new();
    for (index, case) in FIXTURES["cases"].as_array().unwrap().iter().enumerate() {
        let kind = case["kind"].as_str().unwrap();
        if !kinds.contains(&kind) {
            continue;
        }
        count += 1;
        let mut input = case["input"].clone();
        if let Some(count) = case["repeatUsageCount"].as_u64() {
            let row = input["usage"][0].clone();
            input["usage"] = json!(
                (0..count)
                    .map(|n| {
                        let mut row = row.clone();
                        row["usageId"] = json!(format!("00000000-0000-4000-8000-{n:012}"));
                        row
                    })
                    .collect::<Vec<_>>()
            );
        }
        let result = billing::evaluate(kind, &input);
        let valid = case["valid"].as_bool().unwrap();
        if result.is_ok() != valid
            || result
                .as_ref()
                .is_ok_and(|actual| actual != &case["output"])
        {
            failures.push(format!(
                "case {index}: {kind}, source input {}, expected valid {valid}, output {}, result {result:?}",
                case["input"], case["output"]
            ));
        }
    }
    assert!(count > 0);
    assert!(
        failures.is_empty(),
        "{} source comparison failures (first ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
#[test]
fn usage_time_fx_preserves_exact_fractions_reserves_up_and_settles_half_up() {
    check(&["money-capacity", "money-cost"]);
}
#[test]
fn currency_caps_reject_exhaustion_missing_quotes_and_unsafe_intermediate_totals() {
    check(&["money-reserve"]);
}
#[test]
fn budget_admission_preserves_pools_paid_authority_and_independent_currency_units() {
    check(&["ai-allowance", "overage-policy", "budget-admission"]);
}
#[test]
fn currency_changes_carry_capacity_without_repricing_history_or_granting_authority() {
    check(&["money-cutover"]);
}
#[test]
fn invoices_aggregate_exact_fractions_once_and_reject_tampering_duplicates_and_unbounded_precision()
{
    check(&["money-invoice"]);
}
#[test]
fn polar_single_event_acknowledgements_require_exactly_one_insert_or_duplicate() {
    check(&["polar-usage-ack"]);
}
