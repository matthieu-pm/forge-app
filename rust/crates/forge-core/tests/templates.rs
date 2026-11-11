use forge_core::templates as t;
use serde_json::Value;
#[test]
fn template_and_recurring_definitions_match_the_owning_source() {
    let fixture: Value =
        forge_core::json::parse(include_str!("../data/templates-reference.json")).unwrap();
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let input = case["input"].clone();
        let result = match case["kind"].as_str().unwrap() {
            "payload" => t::payload(input),
            "document" => t::document(input),
            "properties" => t::properties(input),
            "scope" => t::scope(input, false),
            "save" => t::save(input, false),
            "delete" => t::delete(input, false),
            "default" => t::default_selection(input),
            "recurring" => t::recurring_payload(input),
            "recurringScope" => t::scope(input, true),
            "recurringSave" => t::save(input, true),
            "recurringDelete" => t::delete(input, true),
            _ => panic!(),
        };
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {index} {}: {result:?}",
            case["kind"]
        );
        if let Ok(value) = result {
            assert_eq!(value, case["output"], "case {index}");
        }
    }
    for case in fixture["empty"].as_array().unwrap() {
        assert_eq!(
            t::empty(case["kind"].as_str().unwrap(), case["team"].as_str()),
            case["output"]
        );
    }
    for case in fixture["schedules"].as_array().unwrap() {
        assert_eq!(
            t::empty_recurring(
                case["team"].as_str().unwrap(),
                case["timezone"].as_str().unwrap(),
                case["now"].as_str().unwrap().parse().unwrap()
            )
            .unwrap(),
            case["output"]
        );
    }
}

#[test]
fn template_payload_size_counts_serialized_utf16_instead_of_utf8_bytes() {
    let fixture: Value =
        forge_core::json::parse(include_str!("../data/templates-reference.json")).unwrap();
    for case in fixture["sizes"].as_array().unwrap() {
        let mut payload = fixture["sizeBase"].clone();
        payload["content"]["content"][0]["attrs"]["source"] =
            serde_json::json!("語".repeat(case["count"].as_u64().unwrap() as usize));
        assert_eq!(
            t::save(serde_json::json!({"payload":payload}), false).is_ok(),
            case["valid"].as_bool().unwrap()
        );
    }
}
