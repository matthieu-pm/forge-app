use forge_core::invitations::{self, DeliveryError, Effect};
use serde_json::{Value, json};

fn reference() -> Value {
    serde_json::from_str(include_str!("../data/invitation-reference.json")).unwrap()
}
#[test]
fn invitation_decisions_and_start_gates_match_the_application() {
    let reference = reference();
    for case in reference["decisions"].as_array().unwrap() {
        let effect: Effect = serde_json::from_value(case["effect"].clone()).unwrap();
        let decision = invitations::classify(
            effect,
            case["status"].as_str().unwrap(),
            case["expiresAt"].as_str().unwrap().parse().unwrap(),
            case["now"].as_str().unwrap().parse().unwrap(),
        );
        assert_eq!(json!(decision), case["decision"], "{case}");
        assert_eq!(effect.key("fixture-invitation"), case["key"]);
    }
    for case in reference["starts"].as_array().unwrap() {
        assert_eq!(
            invitations::can_start(case["sdkRunId"].as_str(), case["state"].as_str().unwrap()),
            case["allowed"],
            "{case}"
        );
    }
    for case in reference["flags"].as_array().unwrap() {
        assert_eq!(
            invitations::enabled(
                case["flag"].as_str().unwrap(),
                case["allowlist"].as_str().unwrap(),
                case["workspace"].as_str().unwrap()
            ),
            case["enabled"],
            "{case}"
        );
    }
}

#[test]
fn delivery_failures_preserve_source_retry_classification_and_delay() {
    for case in reference()["failures"].as_array().unwrap() {
        let error = DeliveryError::provider(
            case["statusCode"].as_u64().map(|value| value as u16),
            case["name"].as_str().unwrap(),
        );
        assert_eq!(error.retryable, case["retryable"], "{case}");
        assert_eq!(
            json!(error.retry_after().map(|delay| delay.num_seconds())),
            case["retrySeconds"],
            "{case}"
        );
        assert_eq!(error.to_string(), "Email delivery failed.");
    }
    assert!(DeliveryError::invalid().retry_after().is_none());
}
