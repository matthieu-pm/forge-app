use forge_core::{
    actor::Actor,
    agents::{
        contracts as c, models as m, policy as p, routing,
        tokens::{self, Kind},
    },
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};
static DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap()
});
fn cases(group: &str) -> &'static Vec<Value> {
    DATA["agents"][group].as_array().unwrap()
}
#[test]
fn production_capability_registry_and_input_schemas_match_the_source() {
    use forge_core::agents::capabilities;
    assert_eq!(
        json!(capabilities::descriptors()),
        DATA["agentCapabilities"]["descriptors"]
    );
    for case in DATA["agentCapabilities"]["inputs"].as_array().unwrap() {
        let result = capabilities::input(case["id"].as_str().unwrap(), case["input"].clone());
        assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(value) = result {
            assert_eq!(value, case["value"], "{case}");
        }
    }
}
#[test]
fn approval_fingerprints_and_program_manifests_match_the_owning_service() {
    use forge_core::agents::approval;
    for case in DATA["agentApprovals"]["hashes"].as_array().unwrap() {
        assert_eq!(
            approval::input_hash(&case["input"]),
            case["hash"].as_str().unwrap(),
            "{case}"
        );
    }
    for case in DATA["agentApprovals"]["grants"].as_array().unwrap() {
        assert_eq!(
            approval::program_grant_allows(
                case["capabilityId"].as_str().unwrap(),
                &case["summary"],
                "teams.update",
                case["version"].as_str().unwrap()
            ),
            case["allowed"].as_bool().unwrap(),
            "{case}"
        );
    }
}
#[test]
fn agent_protocols_normalize_and_reject_like_the_owning_schemas() {
    for case in cases("contracts") {
        let v = case["input"].clone();
        let result = match case["kind"].as_str().unwrap() {
            "createThread" => c::create_thread(v),
            "turn" => c::turn(v, false),
            "localTurn" => c::turn(v, true),
            "resolveApproval" => c::resolve_approval(v, true),
            "decision" => c::resolve_approval(v, false),
            "command" => c::command(v),
            "reference" => m::reference(v),
            "catalog" => m::catalog(v),
            "route" => m::route(v),
            "resolved" => m::resolved(v),
            "connection" => m::connection(v),
            "createConnection" => m::create_connection(v),
            "connectionAction" => m::connection_action(v),
            "preference" => m::preference(v),
            "event" => c::event(v, false, false),
            "append" => c::event(v, true, false),
            "localEvent" => c::event(v, false, true),
            "localEvents" => c::local_events(v),
            "checkpoint" => c::checkpoint(v),
            "localTool" => c::local_tool(v),
            "runtimeApproval" => c::runtime_approval(v, false),
            "localApproval" => c::runtime_approval(v, true),
            "descriptor" => c::capability(v, true),
            "invocation" => c::capability(v, false),
            "result" => c::capability_result(v),
            "artifact" => c::artifact(v),
            "attachment" => c::attachment(v),
            "candidate" => p::candidate(v),
            "evidence" => p::evidence(v),
            _ => panic!("Unknown case {case}"),
        };
        assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(v) = result {
            assert_eq!(v, case["value"], "{case}");
        }
    }
}
#[test]
fn event_safety_preserves_secret_detection_and_utf8_byte_boundaries() {
    for (n, case) in cases("safety").iter().enumerate() {
        let error = c::safe_payload(&case["payload"]).err().map(|e| match e {
            c::UnsafePayload::TooLarge => "PAYLOAD_TOO_LARGE",
            c::UnsafePayload::Sensitive => "SENSITIVE_DATA",
        });
        assert_eq!(json!(error), case["error"], "case {n}");
    }
}
#[test]
fn feature_flags_controls_provider_funding_and_evidence_match_reference() {
    for case in cases("features") {
        let env: HashMap<String, String> = serde_json::from_value(case["input"].clone()).unwrap();
        let flags = p::features(&env);
        assert_eq!(flags, case["expected"], "{case}");
        for (provider, expected) in case["providers"].as_object().unwrap() {
            assert_eq!(
                json!(p::provider_enabled(&flags, provider)),
                *expected,
                "{provider}"
            );
        }
    }
    for case in cases("controls") {
        let env = serde_json::from_value(case["input"].clone()).unwrap();
        assert_eq!(p::controls(&env), case["expected"], "{case}");
    }
    for case in cases("budget") {
        assert_eq!(
            json!(p::budget(
                &case["policy"],
                case["user"].as_f64().unwrap(),
                case["workspace"].as_f64().unwrap()
            )),
            case["error"],
            "{case}"
        );
    }
    for case in cases("providers") {
        assert_eq!(
            p::provider(&case["input"]).unwrap(),
            case["expected"],
            "{case}"
        );
    }
    for case in cases("assessments") {
        assert_eq!(
            p::assess(case["raw"].clone(), case["expected"].clone()),
            case["result"],
            "{case}"
        );
    }
}
#[test]
fn model_routing_keeps_source_choices_efforts_signals_and_failure_messages() {
    for case in cases("routing") {
        match routing::resolve(&case["input"]) {
            Ok(result) => {
                assert!(case["error"].is_null(), "{case}");
                assert_eq!(result, case["result"], "{case}");
            }
            Err(e) => assert_eq!(
                json!({"code":e.code,"message":e.message}),
                case["error"],
                "{case}"
            ),
        }
    }
}
fn kind(v: &Value) -> Kind {
    match v["kind"].as_str().unwrap() {
        "capability" => Kind::Capability,
        "local" => Kind::LocalIngest,
        "model" => Kind::ModelAccess,
        "artifact" => Kind::Artifact,
        _ => panic!(),
    }
}
fn actor() -> Actor {
    serde_json::from_value(json!({"userId":"fixture-user","workspaceId":"fixture-workspace","workspaceRole":"admin","authentication":{"kind":"session","sessionId":"fixture-session"},"scopes":null})).unwrap()
}
const RUN: &str = "00000000-0000-4000-8000-000000000001";
const THREAD: &str = "00000000-0000-4000-8000-000000000002";
#[test]
fn agent_credential_minting_and_claim_validation_interoperate_with_source_jose() {
    let data = &DATA["agentTokens"];
    for case in data["mint"].as_array().unwrap() {
        let result = tokens::mint(
            case["secret"].as_str().unwrap(),
            kind(case),
            case["claims"].clone(),
            case["now"].as_i64().unwrap(),
            case["expires"].as_f64().unwrap(),
        );
        assert_eq!(result.is_err(), case["error"].as_bool().unwrap(), "{case}");
        if let Ok(token) = result {
            assert_eq!(token, case["token"].as_str().unwrap(), "{case}");
        }
    }
    for case in data["verify"].as_array().unwrap() {
        let secret = case["secret"].as_str().unwrap();
        let token = case["token"].as_str().unwrap();
        let now = case["now"].as_i64().unwrap();
        let valid = match kind(case) {
            Kind::Capability => tokens::verify_capability(
                secret,
                token,
                RUN,
                "fixture-workspace",
                "teams.list",
                now,
            )
            .is_ok(),
            Kind::LocalIngest => {
                tokens::verify_local(secret, token, &actor(), RUN, Some(THREAD), now).is_ok()
            }
            Kind::ModelAccess => tokens::verify(secret, Kind::ModelAccess, token, now).is_ok(),
            Kind::Artifact => tokens::verify_artifact(secret, token, &actor(), RUN, now).is_ok(),
        };
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{case}");
    }
    for case in data["scopes"].as_array().unwrap() {
        let capabilities: Vec<String> =
            serde_json::from_value(case["capabilities"].clone()).unwrap();
        assert_eq!(
            json!(tokens::capability_scopes(&capabilities)),
            case["scopes"]
        );
    }
}
#[test]
fn agent_credentials_remain_bound_to_the_run_user_workspace_and_resource() {
    for case in DATA["agentTokens"]["binding"].as_array().unwrap() {
        let secret = case["secret"].as_str().unwrap();
        let token = case["token"].as_str().unwrap();
        let now = case["now"].as_i64().unwrap();
        let expected = &case["expected"];
        let actor = expected
            .get("actor")
            .map(|v| serde_json::from_value(v.clone()).unwrap())
            .unwrap_or_else(actor);
        let run = expected["runId"].as_str().unwrap_or(RUN);
        let valid = match kind(case) {
            Kind::Capability => tokens::verify_capability(
                secret,
                token,
                run,
                expected["workspaceId"]
                    .as_str()
                    .unwrap_or("fixture-workspace"),
                expected["capabilityId"].as_str().unwrap_or("teams.list"),
                now,
            )
            .is_ok(),
            Kind::LocalIngest => tokens::verify_local(
                secret,
                token,
                &actor,
                run,
                Some(expected["threadId"].as_str().unwrap_or(THREAD)),
                now,
            )
            .is_ok(),
            Kind::Artifact => tokens::verify_artifact(
                secret,
                token,
                &actor,
                expected["artifactId"].as_str().unwrap_or(RUN),
                now,
            )
            .is_ok(),
            Kind::ModelAccess => unreachable!(),
        };
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{case}");
    }
}
