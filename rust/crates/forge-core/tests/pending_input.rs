use forge_core::agents::pending_input::{self as pending, PendingState};
use serde_json::{Value, json};
use std::cell::RefCell;

fn current(case: &Value) -> PendingState {
    serde_json::from_value(case["state"].clone()).unwrap()
}
fn evaluate(case: &Value) -> pending::Result<Value> {
    Ok(match case["kind"].as_str().unwrap() {
        "required" => json!(pending::is_required(&case["request"])),
        "has-step" => json!(pending::has_step_input(case.get("input"))),
        "coalesce" => pending::coalesce(&case["first"], &case["second"])?,
        "consume" => json!(pending::consume_deferred(
            &current(case),
            case.get("input")
        )?),
        "clear" => json!(pending::clear_session_limit_prompt(&current(case))),
        "stale" => json!(pending::prepare_stale(
            case["history"].as_array().unwrap(),
            &case["pendingIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            case.get("input"),
        )?),
        "resolve" => {
            let calls = RefCell::new(vec![]);
            let callback = |request: &Value| {
                calls.borrow_mut().push(request.clone());
                case["keys"]
                    .get(request["requestId"].as_str().unwrap())
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let callback: Option<pending::ApprovalKey<'_>> = case
                .get("keys")
                .map(|_| &callback as pending::ApprovalKey<'_>);
            let result = pending::resolve(
                &current(case),
                case["history"].as_array().unwrap(),
                case.get("input"),
                callback,
            )?;
            json!({"resolution":result,"approvalKeyCalls":calls.into_inner()})
        }
        "flow" => {
            let mut state = current(case);
            let mut messages = case["history"].as_array().unwrap().clone();
            let mut outputs = vec![];
            for step in case["inputs"].as_array().unwrap() {
                let consumed = pending::consume_deferred(&state, step.get("input"))?;
                let result =
                    pending::resolve(&consumed.state, &messages, consumed.input.as_ref(), None)?;
                state = result.state.clone();
                messages = result.messages.clone();
                outputs.push(json!({"consumed":consumed,"resolution":result}));
            }
            json!(outputs)
        }
        _ => panic!("Unknown source case"),
    })
}

fn compare(kinds: &[&str]) {
    let fixture: Value =
        serde_json::from_str(include_str!("../data/pending-input-reference.json")).unwrap();
    let mut failures = vec![];
    let mut count = 0;
    for case in fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| kinds.contains(&case["kind"].as_str().unwrap()))
    {
        count += 1;
        let actual = evaluate(case);
        let valid = case["valid"].as_bool().unwrap();
        if actual.is_ok() != valid || valid && actual.as_ref().ok() != Some(&case["output"]) {
            failures.push(format!(
                "{}/{} actual={actual:?}; expected={}",
                case["kind"], case["name"], case["output"]
            ));
        }
    }
    assert!(count > 0);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn pending_classification_consumption_and_cancellation_match_installed_eve() {
    compare(&["required", "has-step", "consume", "clear"]);
}
#[test]
fn pending_resolution_preserves_required_inputs_duplicates_and_rejected_results() {
    compare(&["resolve"]);
}
#[test]
fn deferred_merge_and_sequential_delivery_match_the_source_harness() {
    compare(&["coalesce", "flow", "stale"]);
}
