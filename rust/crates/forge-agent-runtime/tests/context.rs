use forge_agent_runtime::context::{self, Config, Plan};
use forge_core::agents::context as todo;
use serde_json::{Value, json};
fn reference() -> Value {
    serde_json::from_str(include_str!("../data/context-reference.json")).unwrap()
}
#[test]
fn context_tool_matches_source_schema_and_state_transitions() {
    let reference = reference();
    for case in reference["todo"].as_array().unwrap() {
        let result = todo::input("todo", case["input"].clone());
        assert_eq!(result.is_ok(), case["valid"] == true, "{case}");
        if let Ok(result) = result {
            assert_eq!(result, case["result"]);
        }
    }
    let mut todos = vec![];
    for case in reference["todos"].as_array().unwrap() {
        let input = todo::input("todo", case["input"].clone()).unwrap();
        if let Some(items) = input["todos"].as_array() {
            todos = items.clone();
        }
        assert_eq!(todo::output(&todos), case["output"]);
        assert_eq!(
            todo::preservation(&todos).unwrap_or(Value::Null),
            case["preservation"]
        );
    }
    assert!(todo::input("unknown", json!({})).is_err());
}
#[test]
fn token_estimates_and_summary_prompts_match_the_source() {
    let reference = reference();
    assert_eq!(context::prompt::SYSTEM, reference["system"]);
    for case in reference["counts"].as_array().unwrap() {
        let options = &case["options"];
        assert_eq!(
            context::input_count(
                case["messages"].as_array().unwrap(),
                options["lastKnownInputTokens"].as_f64(),
                options["lastKnownPromptMessageCount"].as_f64()
            ),
            case["count"].as_f64().unwrap()
        );
    }
    for (i, case) in reference["prompts"].as_array().unwrap().iter().enumerate() {
        let options = &case["options"];
        let actual = context::prompt::create(
            options["messages"].as_array().unwrap(),
            options["previousCheckpoint"].as_str(),
            options["transcriptBudgetTokens"].as_f64(),
        );
        assert_eq!(
            json!({"system":actual.system,"prompt":actual.prompt}),
            case["result"],
            "prompt {i}"
        );
    }
}
#[test]
fn source_compaction_plans_preserve_results_boundaries_and_resumption() {
    for (i, case) in reference()["compaction"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let messages = case["messages"].as_array().unwrap();
        let config = Config {
            threshold: case["config"]["threshold"].as_u64().unwrap(),
            recent_window: case["config"]["recentWindowSize"].as_u64().unwrap() as usize,
        };
        assert_eq!(
            context::estimate(&json!(messages)),
            case["estimated"].as_f64().unwrap()
        );
        assert_eq!(
            context::should_compact(messages, config, None, None),
            case["should"] == true
        );
        let mut plan = Plan::new(messages, config, case["force"] == true);
        let mut calls = vec![];
        loop {
            match plan {
                Plan::Complete(compacted) => {
                    assert_eq!(
                        compacted,
                        *case["compacted"].as_array().unwrap(),
                        "compaction {i}"
                    );
                    break;
                }
                Plan::Summarize(summary) => {
                    let prompt = summary.prompt();
                    calls.push(
                        json!({"system":prompt.system,"prompt":prompt.prompt,"temperature":0}),
                    );
                    assert!(calls.len() <= 12, "compaction must terminate");
                    plan = summary.accept(&format!(
                        "Saved summary {}.{}",
                        calls.len(),
                        case["summarySuffix"].as_str().unwrap_or("")
                    ));
                }
            }
        }
        assert_eq!(
            calls,
            *case["calls"].as_array().unwrap(),
            "summary requests {i}"
        );
    }
}
