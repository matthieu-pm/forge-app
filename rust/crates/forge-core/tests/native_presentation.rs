use forge_core::agents::{
    contracts::{UnsafePayload, safe_payload},
    presentation::{approval_input, native_event},
};
use serde_json::json;
#[test]
fn native_tool_display_omits_oversized_and_sensitive_data_without_changing_receipt_identity() {
    for (kind, key) in [
        ("tool.started", "input"),
        ("tool.completed", "output"),
        ("code.completed", "output"),
        ("file.read", "output"),
        ("file.patch.proposed", "input"),
        ("file.patch.applied", "output"),
        ("file.search.completed", "output"),
    ] {
        for data in [
            json!({"content":"😀".repeat(40_000)}),
            json!({"token":"private-fixture"}),
            json!({"content":"Bearer fixture-credential-should-not-display"}),
        ] {
            let mut original = json!({"sourceEventId":"native:run:stream-1:call","source":"eve","type":kind,"payload":{"callId":"call","toolName":"write_file"}});
            original["payload"][key] = data.clone();
            assert!(safe_payload(&original["payload"]).is_err());
            let displayed = native_event(original.clone()).unwrap();
            assert_eq!(displayed["sourceEventId"], original["sourceEventId"]);
            assert_eq!(displayed["payload"]["callId"], "call");
            assert_eq!(displayed["payload"]["displayDataOmitted"], true);
            assert!(safe_payload(&displayed["payload"]).is_ok());
            assert_eq!(
                original["payload"][key], data,
                "private content remains untouched"
            );
            assert_eq!(native_event(displayed.clone()).unwrap(), displayed);
        }
    }
    let small = json!({"type":"tool.started","payload":{"input":{"filePath":"/workspace/a"},"callId":"call"}});
    assert_eq!(native_event(small.clone()).unwrap(), small);
    for id in [
        format!("native:run:stream-1:{}", "call".repeat(100)),
        "native:run:stream-1:call ".into(),
    ] {
        let event = json!({"sourceEventId":id,"type":"tool.started","payload":{"callId":"full-provider-call","input":{}}});
        let displayed = native_event(event.clone()).unwrap();
        assert!(displayed["sourceEventId"].as_str().unwrap().len() <= 255);
        assert_eq!(displayed["payload"], event["payload"]);
        assert_eq!(native_event(event).unwrap(), displayed);
        assert_eq!(native_event(displayed.clone()).unwrap(), displayed);
    }
}
#[test]
fn approval_and_semantic_events_cannot_be_truncated_or_redacted_into_acceptance() {
    for kind in [
        "approval.requested",
        "artifact.created",
        "assistant.message",
        "run.usage",
    ] {
        let event = json!({"type":kind,"payload":{"input":{"content":"x".repeat(128*1024)}}});
        assert_eq!(native_event(event).unwrap_err(), UnsafePayload::TooLarge);
    }
    let bad_metadata = json!({"type":"tool.started","payload":{"input":{"content":"x".repeat(128*1024)},"callId":"Bearer fixture-credential-should-not-display"}});
    assert_eq!(
        native_event(bad_metadata).unwrap_err(),
        UnsafePayload::Sensitive
    );
    assert!(approval_input(&json!({"code":"x".repeat(120*1024)})).is_err());
    assert!(approval_input(&json!({"code":"λ".repeat(80_000)})).is_err());
    assert!(approval_input(&json!({"secret":"private"})).is_err());
    assert!(approval_input(&json!({"code":"safe","capabilities":["teams.update"]})).is_ok());
}
