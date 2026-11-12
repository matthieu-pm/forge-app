use forge_core::billing::projection::{Context, Event, Kind};
use serde_json::Value;
use std::sync::LazyLock;
static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/billing-state-reference.json")).unwrap()
});
fn check(kind: &str) {
    let mut failures = vec![];
    let mut count = 0;
    for (index, case) in FIXTURES["cases"].as_array().unwrap().iter().enumerate() {
        if case["kind"] != kind {
            continue;
        }
        count += 1;
        let context: Context = serde_json::from_value(case["context"].clone()).unwrap();
        let result = Event::parse(
            if kind == "snapshot" {
                Kind::Snapshot
            } else {
                Kind::Refund
            },
            &case["input"],
        )
        .and_then(|event| event.plan(&context));
        let actual = result.map(|p| serde_json::to_value(p).unwrap());
        let matches = match &actual {
            Ok(value) => case["valid"] == true && value == &case["output"],
            Err(error) => case["valid"] == false && case["error"] == error.0,
        };
        if !matches {
            failures.push(format!(
                "case {index}: {} context {}; expected {}, error {}, actual {actual:?}",
                case["input"], case["context"], case["output"], case["error"]
            ));
        }
    }
    assert!(count > 0);
    assert!(
        failures.is_empty(),
        "{} source mismatches (first ten):\n{}",
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
fn verified_subscription_transitions_preserve_order_receipts_and_paid_proof() {
    check("snapshot");
}
#[test]
fn verified_refunds_preserve_history_conflicts_and_paid_base_proof() {
    check("refund");
}
