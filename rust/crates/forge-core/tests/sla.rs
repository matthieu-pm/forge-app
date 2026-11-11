use forge_core::sla;
use serde_json::{Value, json};
#[test]
fn shared_sla_policy_boundaries_and_fingerprints_match_source() {
    let data: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let data = &data["sla"];
    for case in data["cases"].as_array().unwrap() {
        let input = case["input"].clone();
        let result = match case["kind"].as_str().unwrap() {
            "duration" => sla::duration(input),
            "rule" => sla::rule(input),
            "policy" => sla::policy(input),
            "command" => sla::command(input),
            "read" => sla::read(input),
            "reconciliation" => sla::reconciliation(input),
            _ => panic!(),
        };
        assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(value) = result {
            assert_eq!(value, case["value"], "{case}");
        }
    }
    for v in data["gates"].as_array().unwrap() {
        assert_eq!(
            json!(sla::gate_identity(
                v["deployment"].as_str().unwrap(),
                v["workspaceId"].as_str().unwrap(),
                v["enabled"].as_bool().unwrap()
            )),
            v["hash"]
        );
    }
    for v in data["versions"].as_array().unwrap() {
        assert_eq!(
            json!(sla::reconciliation_version(
                v["id"].as_str().unwrap(),
                v["gate"].as_str().unwrap(),
                v["classified"].as_str(),
                v["owed"].as_str(),
                v["current"].as_str().unwrap()
            )),
            v["hash"]
        );
    }
}
