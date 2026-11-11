use forge_store::jobs::*;
use serde_json::{Value, json};

#[test]
fn immutable_job_and_recovery_contracts_match_the_owning_source() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for case in fixtures["jobs"]["enqueue"].as_array().unwrap() {
        let input = &case["input"];
        let attempts = input["maxAttempts"].as_f64().unwrap();
        let output = if attempts.fract() != 0. {
            Err(Error::from(Code::InvalidInput))
        } else {
            Enqueue {
                kind: input["kind"].as_str().unwrap().into(),
                scope: input["scope"].as_str().unwrap().into(),
                identity: input["identity"].as_str().unwrap().into(),
                input: input["input"].clone(),
                scheduled_at: input["scheduledAt"].as_str().unwrap().parse().unwrap(),
                max_attempts: attempts as i32,
            }
            .validate()
        };
        match output {
            Ok((body, hash)) => {
                assert!(case["code"].is_null(), "{input}");
                assert_eq!(json!(body), case["body"]);
                assert_eq!(json!(hash), case["fingerprint"]);
            }
            Err(e) => assert_eq!(json!(e.code), case["code"], "{input}"),
        }
    }
    for case in fixtures["jobs"]["recovery"].as_array().unwrap() {
        match Recovery::parse(case["input"].clone()) {
            Ok(r) => {
                assert!(case["code"].is_null(), "{case}");
                assert_eq!(json!(r.fingerprint()), case["fingerprint"]);
            }
            Err(e) => assert_eq!(json!(e.code), case["code"], "{case}"),
        }
    }
    for case in fixtures["jobs"]["cli"].as_array().unwrap() {
        let args = serde_json::from_value::<Vec<String>>(case["args"].clone()).unwrap();
        let expected = if case["code"].is_null() {
            Recovery::parse(case["input"].clone())
        } else {
            Err(Error::from(Code::InvalidInput))
        };
        match (cli::recovery(&args), expected) {
            (Ok(a), Ok(b)) => assert_eq!(a.fingerprint(), b.fingerprint(), "{case}"),
            (Err(a), Err(b)) => assert_eq!(a.code, b.code, "{case}"),
            pair => panic!("CLI mismatch: {case}: {pair:?}"),
        }
    }
}
