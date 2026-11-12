use forge_core::{
    calls::providers::{self, Config, Exchange},
    deployment,
};
use serde_json::{Value, json};
#[test]
fn meeting_oauth_requests_tokens_and_deployment_isolation_match_the_owning_source() {
    let fixture: Value =
        forge_core::json::parse(include_str!("../data/call-provider-reference.json")).unwrap();
    let env = serde_json::from_value(fixture["environment"].clone()).unwrap();
    for case in fixture["authorization"].as_array().unwrap() {
        let config = Config::new(&env, case["provider"].as_str().unwrap()).unwrap();
        assert_eq!(
            config.authorization_url(
                case["state"].as_str().unwrap(),
                case["challenge"].as_str().unwrap()
            ),
            case["output"]
        );
    }
    for (i, case) in fixture["tokens"].as_array().unwrap().iter().enumerate() {
        let input = if let Some(code) = case["input"]["code"].as_str() {
            Exchange::Code {
                code,
                verifier: case["input"]["verifier"].as_str().unwrap(),
            }
        } else {
            Exchange::Refresh {
                refresh_token: case["input"]["refreshToken"].as_str().unwrap(),
            }
        };
        let config = Config::new(&env, case["provider"].as_str().unwrap()).unwrap();
        let request = config.request(&input);
        let form: serde_json::Map<String, Value> = request
            .form
            .into_iter()
            .map(|(k, v)| (k, json!(v)))
            .collect();
        let headers: serde_json::Map<String, Value> = request
            .headers
            .into_iter()
            .map(|(k, v)| (k, json!(v)))
            .collect();
        assert_eq!(
            json!({"url":request.url,"method":"POST","headers":headers,"form":form}),
            case["request"],
            "request {i}"
        );
        let result = providers::tokens(
            case["data"].clone(),
            &input,
            fixture["now"].as_i64().unwrap(),
        );
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "tokens {i}"
        );
        if let Ok(tokens) = result {
            assert_eq!(
                forge_core::json::parse(&forge_core::canonical::javascript_stringify(&json!(
                    tokens
                )))
                .unwrap(),
                case["output"],
                "tokens {i}"
            );
        }
    }
    for (i, case) in fixture["configuration"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let env = serde_json::from_value(case["input"].clone()).unwrap();
        let result = Config::new(&env, "google");
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "config {i}"
        );
        if let Ok(config) = result {
            assert_eq!(
                config.authorization_url("state", "challenge"),
                case["output"]
            );
        }
    }
    for (i, case) in fixture["deployment"].as_array().unwrap().iter().enumerate() {
        let env = serde_json::from_value(case["input"].clone()).unwrap();
        assert_eq!(
            deployment::validate(&env, case["service"].as_str().unwrap()).is_ok(),
            case["valid"].as_bool().unwrap(),
            "deployment {i}"
        );
        assert_eq!(
            json!(deployment::preview_peer(&env)),
            case["peer"],
            "peer {i}"
        );
    }
}
