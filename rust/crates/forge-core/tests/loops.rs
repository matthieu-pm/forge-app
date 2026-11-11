use chrono::{DateTime, Utc};
use forge_core::loops as l;
use serde_json::{Value, json};
use std::sync::LazyLock;

static REFERENCE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../data/loops-reference.json")).unwrap());
fn date(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}
#[test]
fn published_contracts_match_source_validation_and_normalization() {
    let mut errors = Vec::new();
    for (i, c) in REFERENCE["cases"].as_array().unwrap().iter().enumerate() {
        let parse = match c["kind"].as_str().unwrap() {
            "leaf" => l::leaf,
            "condition" => l::condition,
            "trigger" => l::trigger,
            "fields" => l::fields,
            "command" => l::command,
            _ => unreachable!(),
        };
        let result = parse(c["input"].clone());
        if result.is_ok() != c["valid"].as_bool().unwrap()
            || result.as_ref().is_ok_and(|v| *v != c["output"])
        {
            errors.push(format!("contract {i}: {} {result:?}", c["input"]));
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}
#[test]
fn condition_groups_empty_values_text_and_js_scalar_coercion_match_source() {
    for (i, c) in REFERENCE["conditions"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        assert_eq!(
            l::matches_conditions(c["input"].as_array().unwrap(), &c["entity"]),
            c["output"].as_bool().unwrap(),
            "condition {i}: {c}"
        );
    }
}
#[test]
fn native_event_transitions_comments_mentions_and_triage_match_source() {
    for (i, c) in REFERENCE["events"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            l::matches_event(&c["input"], &c["event"]),
            c["output"].as_bool().unwrap(),
            "event {i}: {c}"
        );
    }
}
#[test]
fn schedules_match_source_across_dst_coalescing_intervals_and_calendar_anchors() {
    let mut errors = Vec::new();
    for (i, c) in REFERENCE["schedules"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        // Source Date also accepts minute-only ISO instants.
        let raw = c["after"].as_str().unwrap();
        let after = if raw.len() == 17 {
            date(&format!("{}:00Z", &raw[..16]))
        } else {
            date(raw)
        };
        let result = l::next_scheduled_at(&c["input"], after);
        if result.is_ok() != c["valid"].as_bool().unwrap()
            || result.as_ref().is_ok_and(|next| {
                Some(l::iso_timestamp(*next).as_str()) != c["output"].as_str()
                    || next.timestamp_millis() <= after.timestamp_millis()
            })
        {
            errors.push(format!("schedule {i}: {c} {result:?}"));
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}
#[test]
fn local_start_validation_timezone_interpretation_and_display_match_source() {
    let mut errors = Vec::new();
    for (i, c) in REFERENCE["local"].as_array().unwrap().iter().enumerate() {
        let zone = c["zone"].as_str().unwrap();
        let result = l::schedule_start(c["input"].as_str().unwrap(), zone);
        let matches = result.is_ok() == c["valid"].as_bool().unwrap()
            && match &result {
                Ok(s) => {
                    Some(s.as_str()) == c["output"].as_str()
                        && l::local_date_time(
                            DateTime::from_timestamp_millis(c["outputMs"].as_i64().unwrap())
                                .unwrap(),
                            zone,
                        )
                        .is_ok_and(|v| Some(v.as_str()) == c["display"].as_str())
                }
                Err(e) => Some(*e) == c["message"].as_str(),
            };
        if !matches {
            errors.push(format!("local {i}: {c} {result:?}"));
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}
#[test]
fn published_reasoning_requires_a_compatible_cloud_model_and_retains_auto_audit() {
    for (i, c) in REFERENCE["routes"].as_array().unwrap().iter().enumerate() {
        let result = l::resolve_model(&c["input"]);
        assert_eq!(
            result.is_ok(),
            c["valid"].as_bool().unwrap(),
            "route {i}: {result:?}"
        );
        match result {
            Ok(v) => assert_eq!(v, c["output"], "route {i}"),
            Err(e) => {
                assert_eq!(e.code, c["code"].as_str().unwrap(), "route {i}");
                assert_eq!(e.message, c["message"].as_str().unwrap(), "route {i}");
            }
        }
    }
}
#[test]
fn scheduler_selection_and_trigger_labels_match_source() {
    for c in REFERENCE["drivers"].as_array().unwrap() {
        let result = l::scheduler_driver(&c["input"]);
        assert_eq!(result.is_ok(), c["valid"].as_bool().unwrap());
        match result {
            Ok(v) => assert_eq!(v, c["output"].as_str().unwrap()),
            Err(e) => assert_eq!(e, c["message"].as_str().unwrap()),
        }
    }
    for c in REFERENCE["labels"].as_array().unwrap() {
        assert_eq!(l::trigger_label(&c["input"]), c["output"].as_str().unwrap());
    }
}
#[test]
fn loop_feature_gate_retains_environment_ceiling() {
    assert!(l::enabled(&json!({})));
    assert!(!l::enabled(&json!({"NODE_ENV":"production"})));
    assert!(!l::enabled(&json!({"VERCEL_ENV":"preview"})));
    assert!(!l::enabled(&json!({"FORGE_ENVIRONMENT":"staging"})));
    assert!(!l::enabled(
        &json!({"FORGE_SERVICE_ENVIRONMENT":"production"})
    ));
    assert!(l::enabled(
        &json!({"NODE_ENV":"production","FORGE_LOOPS_ENABLED":"true"})
    ));
    assert!(!l::enabled(&json!({"FORGE_LOOPS_ENABLED":"false"})));
    assert!(!l::enabled(&json!({"FORGE_LOOPS_ENABLED":"TRUE"})));
}
