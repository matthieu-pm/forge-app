use forge_core::agents::{delivery, pending_input};
use serde_json::{Value, json};
use std::collections::VecDeque;

fn evaluate(case: &Value) -> delivery::Result<Value> {
    match case["kind"].as_str().unwrap() {
        "deliveries" => delivery::coalesce_deliveries(case["deliveries"].as_array().unwrap()),
        "payloads" => delivery::coalesce_payloads(case["payloads"].as_array().unwrap()),
        "prefix" => {
            let mut remaining = case["deliveries"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .collect::<VecDeque<_>>();
            let result = match delivery::take_prefix(&mut remaining)? {
                None => json!({"kind":"closed"}),
                Some(deliver) => {
                    let remainder =
                        delivery::coalesce_payloads(deliver["payloads"].as_array().unwrap())?;
                    json!({"kind":"turn","deliver":deliver,"remainder":remainder})
                }
            };
            Ok(json!({"result":result,"remaining":remaining}))
        }
        "resolved-payloads" => {
            let merged = delivery::coalesce_payloads(case["payloads"].as_array().unwrap())?;
            let state = pending_input::PendingState {
                batch: Some(serde_json::from_value(case["batch"].clone()).unwrap()),
                ..Default::default()
            };
            let resolved = pending_input::resolve(&state, &[], Some(&merged), None)
                .map_err(|_| delivery::Error)?;
            Ok(json!({"merged":merged,"outcome":resolved.outcome,"messages":resolved.messages}))
        }
        _ => panic!("Unknown delivery source case"),
    }
}

#[test]
fn queued_delivery_prefix_identity_authority_and_payloads_match_installed_eve() {
    let fixture: Value =
        serde_json::from_str(include_str!("../data/input-delivery-reference.json")).unwrap();
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let actual = evaluate(case);
        let valid = case["valid"].as_bool().unwrap();
        if actual.is_ok() != valid || valid && actual.as_ref().ok() != Some(&case["output"]) {
            failures.push(format!(
                "{}/{} actual={actual:?}; expected={}",
                case["kind"], case["name"], case["output"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
