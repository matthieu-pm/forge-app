use forge_agent_runtime::model::{
    request::Protocol,
    stream::{Completion, Delta, Finish, Parser},
};
use serde_json::{Value, json};
fn fixtures() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("../../../reference-fixtures.json")).unwrap()["modelStreams"].as_array().unwrap().clone()
}
fn protocol(s: &str) -> Protocol {
    match s {
        "responses" => Protocol::Responses,
        "chat" => Protocol::Chat,
        _ => Protocol::Anthropic,
    }
}
fn data(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| serde_json::to_string(v).unwrap())
}
fn project(result: &Completion) -> Value {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tools = vec![];
    for part in &result.content {
        match part["type"].as_str().unwrap() {
            "text" => text.push_str(part["text"].as_str().unwrap()),
            "reasoning" => reasoning.push_str(part["text"].as_str().unwrap()),
            "tool-call" => tools.push(
                json!({"id":part["toolCallId"],"name":part["toolName"],"input":part["input"]}),
            ),
            _ => panic!("unexpected content"),
        }
    }
    json!({"text":text,"reasoning":reasoning,"tools":tools,"finish":result.finish.as_str(),"usage":result.usage})
}
fn parse(p: Protocol, events: &[Value]) -> forge_agent_runtime::Result<Completion> {
    let mut parser = Parser::new(p);
    for event in events {
        parser.push(&data(event))?;
    }
    parser.finish()
}
#[test]
fn completed_streams_match_installed_provider_sdks() {
    let cases = fixtures();
    assert!(cases.len() >= 23);
    for case in cases {
        assert_eq!(case["failed"], false, "{case}");
        let events = case["events"].as_array().unwrap();
        let p = protocol(case["protocol"].as_str().unwrap());
        let mut parser = Parser::new(p);
        let mut text = String::new();
        let mut reasoning = String::new();
        for event in events {
            for delta in parser
                .push(&data(event))
                .unwrap_or_else(|e| panic!("{e}: {event}"))
            {
                match delta {
                    Delta::Text { text: part, .. } => text.push_str(&part),
                    Delta::Reasoning { text: part, .. } => reasoning.push_str(&part),
                    _ => {}
                }
            }
        }
        let completion = parser.finish().unwrap_or_else(|e| panic!("{e}: {case}"));
        assert_eq!(
            project(&completion),
            case["expected"],
            "{} {}",
            case["protocol"],
            case["mode"]
        );
        assert_eq!(text, case["expected"]["text"]);
        assert_eq!(reasoning, case["expected"]["reasoning"]);
        if p == Protocol::Anthropic && case["mode"] == "reasoning" {
            assert_eq!(
                completion.content[0]["providerOptions"]["anthropic"]["signature"],
                "signed-fixture"
            );
        }
        if p == Protocol::Responses {
            assert!(
                completion
                    .content
                    .iter()
                    .all(|v| v["providerOptions"]["openai"]["itemId"].is_string())
            );
        }
    }
}
#[test]
fn tool_calls_are_unavailable_until_a_complete_response_and_invalid_streams_stay_failed() {
    for case in fixtures().into_iter().filter(|v| v["mode"] == "tool") {
        let events = case["events"].as_array().unwrap();
        let p = protocol(case["protocol"].as_str().unwrap());
        let terminal = match p {
            Protocol::Chat => events.len() - 3,
            _ => events.len() - 1,
        };
        for prefix in 0..=terminal {
            assert!(
                parse(p, &events[..prefix]).is_err(),
                "{} prefix {prefix}",
                case["protocol"]
            );
        }
        let mut parser = Parser::new(p);
        assert!(parser.push("{malformed").is_err());
        for event in events {
            assert!(parser.push(&data(event)).is_err());
        }
        assert!(parser.finish().is_err());
        let mut broken = events.clone();
        broken.insert(
            terminal,
            json!({"type":"error","error":{"message":"sk-private-provider-error"}}),
        );
        let error = parse(p, &broken).err().unwrap().to_string();
        assert!(!error.contains("sk-private"));
    }
}
#[test]
fn mismatched_identity_duplicate_blocks_and_post_terminal_data_fail_closed() {
    for case in fixtures().into_iter().filter(|v| v["mode"] == "tool") {
        let p = protocol(case["protocol"].as_str().unwrap());
        let original = case["events"].as_array().unwrap();
        let mut duplicate = original.clone();
        duplicate.insert(1, original[0].clone());
        assert!(parse(p, &duplicate).is_err());
        let mut tail = original.clone();
        tail.push(original[0].clone());
        assert!(parse(p, &tail).is_err());
        let mut changed = original.clone();
        match p {
            Protocol::Responses => {
                let end = changed
                    .iter_mut()
                    .find(|v| v["type"] == "response.output_item.done")
                    .unwrap();
                end["item"]["call_id"] = json!("different");
            }
            Protocol::Chat => changed[1]["id"] = json!("different-response"),
            Protocol::Anthropic => changed[2]["index"] = json!(100),
        }
        assert!(parse(p, &changed).is_err());
    }
}
#[test]
fn malformed_arguments_excessive_content_and_invalid_counters_cannot_be_executed() {
    let original = fixtures()
        .into_iter()
        .find(|v| v["protocol"] == "chat" && v["mode"] == "tool")
        .unwrap();
    for key in ["id", "name"] {
        let mut events = original["events"].as_array().unwrap().clone();
        if key == "id" {
            events[1]["choices"][0]["delta"]["tool_calls"][0]["id"] = json!(17);
        } else {
            events[1]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] = json!(17);
        }
        assert!(parse(Protocol::Chat, &events).is_err());
    }
    for invalid in ["{", "[]", "null"] {
        let mut events = original["events"].as_array().unwrap().clone();
        events[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] = json!(invalid);
        events[1]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] = json!("");
        assert!(parse(Protocol::Chat, &events).is_err());
        events[2]["choices"][0]["finish_reason"] = json!("length");
        let result = parse(Protocol::Chat, &events).unwrap();
        assert_eq!(result.finish, Finish::Length);
        assert!(result.content.is_empty());
        assert_eq!(result.usage["outputTokens"], 5);
    }
    for counter in [
        json!(-1),
        json!(1.5),
        json!("10"),
        json!(9007199254740992u64),
    ] {
        let mut events = original["events"].as_array().unwrap().clone();
        events[3]["usage"]["prompt_tokens"] = counter;
        assert!(parse(Protocol::Chat, &events).is_err());
    }
    let mut parser = Parser::new(Protocol::Chat);
    assert!(
        parser
            .push(&data(
                &json!({"choices":[{"index":0,"delta":{"content":"x".repeat(4*1024*1024+1)}}]})
            ))
            .is_err()
    );
    let mut parser = Parser::new(Protocol::Chat);
    for index in 0..128 {
        parser.push(&data(&json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":index,"id":format!("call_{index}"),"function":{"name":"get_team","arguments":"{}"}}]}}]}))).unwrap();
    }
    assert!(parser.push(&data(&json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":128,"id":"overflow","function":{"name":"get_team","arguments":"{}"}}]}}]}))).is_err());
}
#[test]
fn provider_executed_tools_and_invalid_anthropic_terminators_are_rejected() {
    let case = fixtures()
        .into_iter()
        .find(|v| v["protocol"] == "anthropic" && v["mode"] == "tool")
        .unwrap();
    let mut events = case["events"].as_array().unwrap().clone();
    events[1]["content_block"]["type"] = json!("server_tool_use");
    assert!(parse(Protocol::Anthropic, &events).is_err());
    events = case["events"].as_array().unwrap().clone();
    events[1]["content_block"]["caller"] =
        json!({"type":"code_execution_20260120","tool_id":"server"});
    assert!(parse(Protocol::Anthropic, &events).is_err());
    events = case["events"].as_array().unwrap().clone();
    *events.last_mut().unwrap() = json!("[DONE]");
    assert!(parse(Protocol::Anthropic, &events).is_err());
}
