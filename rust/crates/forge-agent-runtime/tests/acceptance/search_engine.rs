use super::*;
use forge_agent_runtime::model::{request::Protocol, stream::Parser};
fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../data/search-reference.json")).unwrap()
}
fn pair() -> Vec<Value> {
    vec![
        json!({"type":"tool-call","toolCallId":"search_fixture","toolName":"web_search","input":{},"providerExecuted":true}),
        json!({"type":"tool-result","toolCallId":"search_fixture","toolName":"web_search","output":{"type":"json","value":{"action":{"type":"search","query":"Forge"},"sources":[{"type":"url","url":"https://example.com"}]}}}),
    ]
}
#[tokio::test]
async fn provider_search_streams_settle_atomically_without_host_tools_and_continue_when_needed() {
    for case in fixtures()["streams"].as_array().unwrap() {
        let provider = if case["protocol"] == "responses" {
            "openai"
        } else {
            "anthropic"
        };
        let mut parser = Parser::new(Protocol::for_provider(provider));
        for event in case["events"].as_array().unwrap() {
            parser.push(&event.to_string()).unwrap();
        }
        let completion = parser.finish().unwrap();
        let mut content = completion.content.clone();
        let expected = if case["variant"] == "only" { 2 } else { 1 };
        let channel = make_provider_channel("owner", provider);
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![content.clone()]));
        let (engine, calls) = setup(model.clone(), journal.clone(), None);
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline(),
            )
            .await
            .unwrap();
        assert_eq!(
            state.phase(),
            Phase::Complete,
            "{provider} {}",
            case["variant"]
        );
        assert_eq!(model.calls.load(Ordering::SeqCst), expected);
        assert_eq!(state.usage(), (10 * expected as u64, 5 * expected as u64));
        assert!(calls.requests.lock().unwrap().is_empty());
        assert!(state.snapshot()["calls"].as_array().unwrap().is_empty());
        assert_eq!(state.snapshot()["workspace"]["provisioned"], false);
        let events = journal.events.lock().unwrap().clone();
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "action.result")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "turn.completed")
                .count(),
            1
        );
        assert!(
            !json!(events)
                .to_string()
                .contains("fixture-encrypted-content")
        );
        if case["variant"] == "error" {
            assert!(
                journal
                    .normalized()
                    .iter()
                    .any(|e| e["type"] == "tool.failed")
            );
        }
        if case["variant"] == "citations" {
            let answer = events
                .iter()
                .find(|e| e["type"] == "message.completed")
                .unwrap();
            assert_eq!(answer["data"]["sources"][0]["url"], "https://example.com");
        }
        // The private summary sees the materialized search outcome too.
        content.retain(|p| p["type"] != "text");
        let prompt = forge_agent_runtime::context::prompt::create(
            &[json!({"role":"assistant","content":content})],
            None,
            None,
        );
        assert!(json!(prompt.messages()).to_string().contains("web_search"));
    }
}
#[tokio::test]
async fn provider_continuation_order_matches_the_installed_harness() {
    for case in fixtures()["continuations"].as_array().unwrap() {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![
            case["content"].as_array().unwrap().clone(),
        ]));
        let (engine, calls) = setup(model.clone(), journal.clone(), None);
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline(),
            )
            .await
            .unwrap();
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            if case["continues"] == true { 2 } else { 1 }
        );
        assert!(calls.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn provider_receipts_survive_lost_acknowledgements_without_repeating_completed_searches() {
    for after in [false, true] {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        if after {
            journal.fail_after.store(2, Ordering::SeqCst);
        } else {
            journal.fail_before.store(2, Ordering::SeqCst);
        }
        let model = Arc::new(Scripted::new(vec![pair()]));
        let (engine, calls) = setup(model.clone(), journal.clone(), None);
        assert!(
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .is_err()
        );
        let mut restored = journal.load(&channel);
        assert_eq!(
            restored.phase(),
            if after {
                Phase::Ready
            } else {
                Phase::Generating
            }
        );
        engine
            .drive(
                &channel,
                &mut restored,
                journal.as_ref(),
                &Cancellation::default(),
                deadline(),
            )
            .await
            .unwrap();
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            if after { 2 } else { 3 }
        );
        assert_eq!(restored.usage(), (20, 10));
        let events = journal.events.lock().unwrap().clone();
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "action.result")
                .count(),
            1
        );
        assert!(calls.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn forged_provider_actions_cannot_become_host_effects_or_trusted_receipts() {
    let valid = pair();
    let mut invalid = vec![];
    for key in ["toolName", "toolCallId"] {
        let mut parts = valid.clone();
        parts[1][key] = json!("wrong");
        invalid.push(parts);
    }
    let mut parts = valid.clone();
    parts[0]["toolName"] = json!("update_team");
    invalid.push(parts);
    let mut parts = valid.clone();
    parts[0]["providerExecuted"] = json!(false);
    invalid.push(parts);
    let mut parts = valid.clone();
    parts.push(parts[1].clone());
    invalid.push(parts);
    let mut parts = valid.clone();
    parts.insert(0,json!({"type":"tool-call","toolCallId":"search_fixture","toolName":"update_team","input":{}}));
    invalid.push(parts);
    let mut parts = valid.clone();
    parts[1]["output"]["value"]["extra"] = json!(true);
    invalid.push(parts);
    invalid.push(vec![valid[0].clone()]);
    invalid.push(vec![valid[1].clone(), valid[0].clone()]);
    for content in invalid {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![content]));
        let (engine, calls) = setup(model, journal.clone(), None);
        assert!(
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .is_err()
        );
        assert!(calls.requests.lock().unwrap().is_empty());
        assert!(
            !journal
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "actions.requested" || e["type"] == "action.result")
        );
    }
}
#[tokio::test]
async fn chat_compatible_models_do_not_advertise_unsupported_provider_search() {
    let channel = make_provider_channel("owner", "custom-openai");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let mut model = Scripted::new(vec![]);
    model.tools = 9;
    let (engine, _) = setup(Arc::new(model), journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(state.phase(), Phase::Complete);
}
