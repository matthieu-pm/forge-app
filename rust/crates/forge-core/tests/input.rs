use forge_core::agents::input;
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../data/input-reference.json")).unwrap()
}

#[test]
fn question_contracts_match_the_installed_eve_schemas() {
    let fixture = fixture();
    let mut failures = vec![];
    for kind in ["inputs", "responses", "outputs"] {
        let cases = fixture[kind].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let result = match kind {
                "inputs" => input::input(case["input"].clone()),
                "responses" => input::response(case["input"].clone()),
                _ => input::output(case["input"].clone()),
            };
            let valid = case["valid"].as_bool().unwrap();
            if result.is_ok() != valid || (valid && result.as_ref().ok() != Some(&case["output"])) {
                failures.push(format!(
                    "{kind}/{} input={} result={result:?}; expected {}",
                    case["name"], case["input"], case
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn question_requests_and_typed_results_match_eve_extraction_and_resolution() {
    let fixture = fixture();
    let mut failures = vec![];
    for case in fixture["questions"].as_array().unwrap() {
        let result = input::question(case["callId"].as_str().unwrap(), &case["input"]);
        if result != case["output"] {
            failures.push(format!(
                "request/{} result={result}; expected {}",
                case["name"], case["output"]
            ));
        }
    }
    for case in fixture["results"].as_array().unwrap() {
        let result = input::question_output(case.get("response"));
        if result != case["output"] {
            failures.push(format!(
                "result/{} result={result}; expected {}",
                case["name"], case["output"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn composer_text_matching_preserves_eve_precedence_unicode_and_numeric_indices() {
    let fixture = fixture();
    let mut failures = vec![];
    let cases = fixture["text"].as_array().unwrap();
    assert!(cases.len() >= 100);
    for case in cases {
        let result = input::resolve_text(
            case["text"].as_str().unwrap(),
            case["requests"].as_array().unwrap(),
        );
        if json!(result) != case["output"] {
            failures.push(format!(
                "{} result={}; expected {}",
                case["name"],
                json!(result),
                case["output"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
