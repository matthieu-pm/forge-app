use forge_agent_runtime::{auth::Channel, model::request};
use forge_core::agents::tokens::{Kind, mint};
use serde_json::{Value, json};

fn channel(provider: &str, model: &str) -> Channel {
    let secret = "public-model-request-fixture-secret";
    let token = mint(secret, Kind::RuntimeChannel, json!({
        "sub":"fixture-user", "workspaceId":"fixture-workspace",
        "runId":"00000000-0000-4000-8000-000000000001",
        "forgeCapabilityToken":"public-capability-token", "forgeModelAccessToken":"public-model-access-token",
        "provider":provider,"modelId":model,"reasoningEffort":"medium"
    }), 1000, 900.).unwrap();
    Channel::verify(secret, &format!("Bearer {token}"), 1001).unwrap()
}

#[test]
fn requests_match_installed_sdk_protocols_histories_files_and_token_limits() {
    let data: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    let cases = data["modelRuntime"].as_array().unwrap();
    assert!(cases.len() >= 200);
    for (index, fixture) in cases.iter().enumerate() {
        assert_eq!(fixture["failed"], false, "SDK fixture {index}");
        let input = &fixture["input"];
        let bound = channel(
            input["provider"].as_str().unwrap(),
            input["modelId"].as_str().unwrap(),
        );
        let result = if input["temperature"] == 0 {
            request::build_compaction(
                &bound,
                input["prompt"].as_array().unwrap(),
                input["maxOutputTokens"].as_u64().map(|v| v as u32),
            )
        } else {
            request::build(
                &bound,
                input["prompt"].as_array().unwrap(),
                input["tools"].as_array().unwrap(),
                input["maxOutputTokens"].as_u64().map(|v| v as u32),
            )
        }
        .unwrap_or_else(|error| panic!("fixture {index}: {error}"));
        assert_eq!(
            result.body, fixture["request"]["body"],
            "fixture {index}: {}",
            input
        );
        assert_eq!(
            format!("/api/agent/runtime/model/{}", result.protocol.path()),
            fixture["request"]["path"]
        );
    }
}

#[test]
fn model_identity_is_bound_and_unsupported_content_fails_closed() {
    for provider in ["openai", "custom-openai", "anthropic"] {
        let channel = channel(provider, "bound-model");
        let valid =
            json!({"role":"user","content":[{"type":"text","text":"Hello"}],"model":"override"});
        let result = request::build(&channel, std::slice::from_ref(&valid), &[], Some(1)).unwrap();
        assert_eq!(result.body["model"], "bound-model");
        assert_eq!(result.body["stream"], true);
        for bad in [
            json!({"role":"admin","content":"override"}),
            json!({"role":"user","content":"not parts"}),
            json!({"role":"user","content":[{"type":"text","text":17}]}),
            json!({"role":"user","content":[{"type":"file","data":{"type":"url","url":"http://127.0.0.1/private"},"mediaType":"image/png"}]}),
            json!({"role":"user","content":[{"type":"file","data":{"type":"reference","reference":"file-private"},"mediaType":"image/png"}]}),
            json!({"role":"user","content":[{"type":"file","data":{"type":"data","data":"WA=="},"mediaType":"application/unknown"}]}),
            json!({"role":"assistant","content":[{"type":"unknown","text":"private"}]}),
            json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"a","output":{"type":"unknown"}}]}),
        ] {
            assert!(request::build(&channel, &[bad], &[], Some(1)).is_err());
        }
        assert!(request::build(&channel, &[], &[], None).is_err());
        assert!(request::build(&channel, std::slice::from_ref(&valid), &[], Some(0)).is_err());
        assert!(request::build(&channel, &vec![valid.clone(); 10001], &[], None).is_err());
        for tool in [
            json!({"type":"provider","name":"shell"}),
            json!({"type":"function","name":"","inputSchema":{}}),
            json!({"type":"function","name":"shell","inputSchema":[]}),
        ] {
            assert!(request::build(&channel, std::slice::from_ref(&valid), &[tool], None).is_err());
        }
        assert!(
            request::build(
                &channel,
                std::slice::from_ref(&valid),
                &vec![json!({}); 129],
                None
            )
            .is_err()
        );
        let oversized =
            json!({"role":"user","content":[{"type":"text","text":"x".repeat(4*1024*1024)}]});
        assert!(request::build(&channel, &[oversized], &[], None).is_err());
    }
}
