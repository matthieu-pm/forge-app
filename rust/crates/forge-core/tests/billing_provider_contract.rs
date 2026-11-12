use forge_core::billing::{
    configuration::Enabled,
    provider::{catalog, snapshot},
};
use serde_json::Value;
use std::sync::LazyLock;

static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../data/billing-provider-contract-reference.json"
    ))
    .unwrap()
});
fn config(value: &Value) -> Enabled {
    Enabled {
        enabled: true,
        environment: value["environment"].as_str().unwrap().into(),
        access_token: value["accessToken"].as_str().unwrap().into(),
        webhook_secret: value["webhookSecret"].as_str().unwrap().into(),
        paid_products: value["paidProducts"].clone(),
        app_url: value["appUrl"].as_str().unwrap().into(),
    }
}
fn check(kind: &str) {
    let mut failures = Vec::new();
    let mut count = 0;
    for (index, case) in FIXTURES["cases"].as_array().unwrap().iter().enumerate() {
        if case["kind"] != kind {
            continue;
        }
        count += 1;
        let input = &case["input"];
        let actual = if kind == "catalog" {
            catalog(&input["product"], &input["selection"])
        } else {
            snapshot(
                &config(case.get("config").unwrap_or(&FIXTURES["config"])),
                input["workspaceId"].as_str().unwrap(),
                input["subscriptionId"].as_str().unwrap(),
                &input["subscription"],
            )
        };
        let matches = match &actual {
            Ok(value) => case["valid"] == true && value == &case["output"],
            Err(error) => case["valid"] == false && case["error"] == error.0,
        };
        if !matches {
            failures.push(format!(
                "case {index} {kind}: input {input}; expected {}, error {}, actual {actual:?}",
                case["output"], case["error"]
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
fn native_currency_catalogue_preserves_active_prices_tiers_and_tax_exclusivity() {
    check("catalog");
}
#[test]
fn provider_observations_preserve_required_nullable_fields_and_restrictive_lifecycle() {
    check("snapshot");
}
