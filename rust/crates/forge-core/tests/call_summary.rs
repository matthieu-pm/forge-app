use forge_core::calls::providers::{summary_request, summary_response};
use serde_json::{Value, json};
#[test]
fn call_summary_requests_preserve_source_policy_and_validate_bounded_recaps() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../data/call-sync-reference.json")).unwrap();
    for case in fixtures["summaryRequests"].as_array().unwrap() {
        assert_eq!(
            summary_request(
                &serde_json::from_value(case["environment"].clone()).unwrap(),
                case["text"].as_str().unwrap()
            )
            .unwrap(),
            case["output"]
        );
    }
    assert!(summary_request(&Default::default(), &"🙂".repeat(125000)).is_ok());
    assert!(summary_request(&Default::default(), &"🙂".repeat(125001)).is_err());
    let recap =
        json!({"summary":"Short","decisions":["Pilot"],"actions":[{"title":"Prepare","owner":""}]});
    assert_eq!(
        summary_response(json!({"choices":[{"message":{"content":recap.to_string()}}]})).unwrap(),
        recap
    );
    for content in [
        "null".into(),
        "not JSON".into(),
        "{}".into(),
        json!({"summary":"x".repeat(8001),"decisions":[],"actions":[]}).to_string(),
        json!({"summary":"","decisions":[],"actions":[{"title":"","owner":""}]}).to_string(),
    ] {
        assert!(summary_response(json!({"choices":[{"message":{"content":content}}]})).is_err());
    }
    assert!(summary_response(json!({})).is_err());
}
