use forge_agent_runtime::{
    Result,
    model::{
        request::{self, Protocol},
        stream::{Completion, Parser},
    },
};
use serde_json::{Value, json};
fn fixtures() -> Value {
    serde_json::from_str(include_str!("../data/search-reference.json")).unwrap()
}
fn protocol(value: &Value) -> Protocol {
    if value == "responses" {
        Protocol::Responses
    } else {
        Protocol::Anthropic
    }
}
fn parse(protocol: Protocol, events: &[Value]) -> Result<Completion> {
    let mut parser = Parser::new(protocol);
    for event in events {
        parser.push(&event.to_string())?;
    }
    parser.finish()
}
#[test]
fn provider_search_requests_and_histories_match_the_installed_sdks() {
    for (i, case) in fixtures()["requests"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        assert_eq!(case["failed"], false);
        let input = &case["input"];
        let request = build(
            input["provider"].as_str().unwrap(),
            input["modelId"].as_str().unwrap(),
            input["prompt"].as_array().unwrap(),
            input["tools"].as_array().unwrap(),
            Some(1024),
        )
        .unwrap_or_else(|e| panic!("case {i}: {e}"));
        assert_eq!(request.body, case["request"]["body"], "case {i}");
    }
    let prompt = [json!({"role":"user","content":[{"type":"text","text":"Search"}]})];
    for tool in [
        json!({"type":"provider","id":"openai.web_search","name":"execute_program","args":{}}),
        json!({"type":"provider","id":"openai.computer_use","name":"web_search","args":{}}),
        json!({"type":"provider","id":"openai.web_search","name":"web_search","args":{"externalWebAccess":false}}),
    ] {
        assert!(build("openai", "fixture", &prompt, &[tool], None).is_err());
    }
}
#[test]
fn completed_search_results_match_provider_streams_without_becoming_host_tools() {
    for case in fixtures()["streams"].as_array().unwrap() {
        assert_eq!(case["failed"], false);
        let mut result = parse(
            protocol(&case["protocol"]),
            case["events"].as_array().unwrap(),
        )
        .unwrap_or_else(|e| panic!("{} {}: {e}", case["protocol"], case["variant"]));
        let citations = result
            .content
            .iter()
            .flat_map(|p| {
                p["providerOptions"]["forge"]["sources"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .map(|c| {
                let mut c = c.clone();
                c.as_object_mut().unwrap().remove("startIndex");
                c.as_object_mut().unwrap().remove("endIndex");
                c
            })
            .collect::<Vec<_>>();
        for part in &mut result.content {
            part.as_object_mut().unwrap().remove("providerOptions");
        }
        assert_eq!(
            json!({"parts":result.content,"finish":result.finish.as_str(),"usage":result.usage,"citations":citations}),
            case["expected"]
        );
        assert_eq!(result.content[0]["providerExecuted"], true);
    }
}
#[test]
fn mismatched_duplicate_incomplete_and_unsupported_search_responses_fail_closed() {
    for case in fixtures()["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["variant"] == "search")
    {
        let p = protocol(&case["protocol"]);
        let events = case["events"].as_array().unwrap();
        for length in 0..events.len() {
            assert!(parse(p, &events[..length]).is_err(), "prefix {length}");
        }
        let mut wrong = events.clone();
        let index = if p == Protocol::Responses { 2 } else { 4 };
        if p == Protocol::Responses {
            wrong[index]["item"]["id"] = json!("foreign");
        } else {
            wrong[index]["content_block"]["tool_use_id"] = json!("foreign");
        }
        assert!(parse(p, &wrong).is_err());
        let mut duplicate = events.clone();
        duplicate.insert(index, events[index].clone());
        assert!(parse(p, &duplicate).is_err());
        let mut unsupported = events.clone();
        if p == Protocol::Responses {
            unsupported[1]["item"]["type"] = json!("computer_call");
        } else {
            unsupported[1]["content_block"]["name"] = json!("execute_program");
        }
        assert!(parse(p, &unsupported).is_err());
        let mut missing = events.clone();
        if p == Protocol::Responses {
            missing.remove(2);
        } else {
            missing.drain(4..6);
        }
        assert!(parse(p, &missing).is_err());
        let mut malformed = events.clone();
        if p == Protocol::Responses {
            malformed[2]["item"]["action"]["sources"] = json!([{"type":"url","url":1}]);
        } else {
            malformed[4]["content_block"]["content"][0]["title"] = json!(null);
        }
        assert!(parse(p, &malformed).is_err());
    }
}
#[test]
fn citations_preserve_source_links_and_opaque_provider_history_with_bounded_validation() {
    for case in fixtures()["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["variant"] == "search")
    {
        let p = protocol(&case["protocol"]);
        let mut events = case["events"].as_array().unwrap().clone();
        let citation = if p == Protocol::Responses {
            json!({"type":"response.output_text.annotation.added","item_id":"message_fixture","output_index":1,"annotation":{"type":"url_citation","url":"https://example.com","title":"Example","start_index":0,"end_index":11}})
        } else {
            json!({"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com","title":"Example","cited_text":"Found this.","encrypted_index":"fixture-opaque-citation"}}})
        };
        let at = if p == Protocol::Responses { 5 } else { 8 };
        events.insert(at, citation.clone());
        let result = parse(p, &events).unwrap();
        let text = result.content.iter().find(|v| v["type"] == "text").unwrap();
        assert_eq!(
            text["providerOptions"]["forge"]["sources"][0]["url"],
            "https://example.com"
        );
        if p == Protocol::Anthropic {
            assert_eq!(
                text["providerOptions"]["anthropic"]["citations"][0]["encrypted_index"],
                "fixture-opaque-citation"
            );
            let prompt = [json!({"role":"assistant","content":result.content})];
            let request = build("anthropic", "claude-sonnet-4-5", &prompt, &[], None).unwrap();
            assert_eq!(
                request.body["messages"][0]["content"][2]["citations"][0],
                citation["delta"]["citation"]
            );
        }
        let mut wrong = events.clone();
        if p == Protocol::Responses {
            wrong[at]["annotation"]["end_index"] = json!(-1);
        } else {
            wrong[at]["delta"]["citation"]["encrypted_index"] = json!(null);
        }
        assert!(parse(p, &wrong).is_err());
        let mut flood = events;
        flood.splice(at..at, std::iter::repeat_n(citation, 1024));
        assert!(parse(p, &flood).is_err());
    }
}

fn build(
    provider: &str,
    model: &str,
    prompt: &[Value],
    tools: &[Value],
    max: Option<u32>,
) -> Result<request::Request> {
    use forge_core::agents::tokens::{Kind, mint};
    let secret = "public-search-fixture-signing-secret";
    let token=mint(secret,Kind::RuntimeChannel,json!({"sub":"owner","workspaceId":"workspace","runId":"00000000-0000-4000-8000-000000000001","forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-token","provider":provider,"modelId":model,"reasoningEffort":"medium"}),1000,900.).unwrap();
    let channel =
        forge_agent_runtime::auth::Channel::verify(secret, &format!("Bearer {token}"), 1001)
            .unwrap();
    request::build(&channel, prompt, tools, max)
}
