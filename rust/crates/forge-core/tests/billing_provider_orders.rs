use forge_core::billing::{
    Error, Result,
    configuration::Enabled,
    provider::{orders, refund},
};
use serde_json::Value;
use std::sync::LazyLock;

static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../data/billing-provider-orders-reference.json"
    ))
    .unwrap()
});

fn evaluate(kind: &str, input: &Value) -> Result<Value> {
    match kind {
        "amounts" => Ok(Value::Bool(orders::consistent_amounts(&input["order"]))),
        "upgrade" => orders::upgrade(&input["context"], &input["order"]),
        "starter-basis" => orders::starter_basis(&input["context"], &input["order"]),
        "refund" => {
            let raw = &input["config"];
            let config = Enabled {
                enabled: true,
                environment: raw["environment"].as_str().unwrap().into(),
                access_token: "fixture".into(),
                webhook_secret: "fixture".into(),
                paid_products: raw["paidProducts"].clone(),
                app_url: "https://forge.example".into(),
            };
            refund::verify(
                &config,
                input["workspaceId"].as_str().unwrap(),
                input["orderId"].as_str().unwrap(),
                &input["order"],
            )
        }
        _ => Err(Error("UNKNOWN_FIXTURE")),
    }
}

fn check(kind: &str) {
    let mut count = 0;
    let mut failures = vec![];
    for (index, case) in FIXTURES["cases"].as_array().unwrap().iter().enumerate() {
        if case["kind"] != kind {
            continue;
        }
        count += 1;
        let actual = evaluate(kind, &case["input"]);
        let agrees = match &actual {
            Ok(value) => case["valid"] == true && value == &case["output"],
            Err(error) => case["valid"] == false && case["error"] == error.0,
        };
        if !agrees {
            failures.push(format!(
                "case {index} {kind}: input {}; expected {}, error {}; actual {actual:?}",
                case["input"], case["output"], case["error"]
            ));
        }
    }
    assert!(count > 0);
    assert!(
        failures.is_empty(),
        "{} source mismatches (first ten):\n{}",
        failures.len(),
        failures.into_iter().take(10).collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn paid_invoice_amounts_preserve_exact_balance_and_refund_arithmetic() {
    check("amounts");
}
#[test]
fn paid_upgrade_proof_requires_bound_paid_invoices_and_matching_line_periods() {
    check("upgrade");
}
#[test]
fn starter_basis_requires_original_nonprorated_paid_term() {
    check("starter-basis");
}
#[test]
fn refund_allocation_requires_exact_scope_amount_status_and_period_proof() {
    check("refund");
}
