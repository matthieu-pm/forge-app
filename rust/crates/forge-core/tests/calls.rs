use forge_core::calls;
use serde_json::Value;
#[test]
fn call_inputs_transcript_normalization_and_provider_selection_match_the_owning_source() {
    let fixture: Value =
        forge_core::json::parse(include_str!("../data/calls-reference.json")).unwrap();
    for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let result = calls::input(case["kind"].as_str().unwrap(), case["input"].clone());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {i} {}: {result:?}",
            case["kind"]
        );
        if let Ok(value) = result {
            assert_eq!(value, case["output"], "case {i}");
        }
    }
    for (i, case) in fixture["transcripts"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        assert_eq!(
            calls::transcript_json(&calls::parse_transcript(case["input"].as_str().unwrap())),
            case["output"],
            "transcript {i}"
        );
    }
    for case in fixture["labels"].as_array().unwrap() {
        assert_eq!(
            calls::timestamp_label(case["input"].as_f64().unwrap()),
            case["output"]
        );
    }
    for case in fixture["providers"].as_array().unwrap() {
        let env = serde_json::from_value(case["input"].clone()).unwrap();
        assert_eq!(
            serde_json::json!(calls::selected_providers(&env)),
            case["output"]
        );
        assert!(calls::configured_providers(&env).is_empty());
    }
}
