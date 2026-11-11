use chrono::{DateTime, Duration, Utc};
use forge_core::workflow_health::{self, Code, Effect, Job, Run};
use serde_json::{Value, json};
use uuid::Uuid;

#[test]
fn business_health_thresholds_and_precedence_match_the_owning_script() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../data/workflow-health-reference.json")).unwrap();
    for case in cases {
        let run: Run = serde_json::from_value(case["input"].clone()).unwrap();
        let code = workflow_health::classify(&run, case["now"].as_str().unwrap().parse().unwrap());
        assert_eq!(json!(code), case["code"], "{case}");
        assert_eq!(
            usize::from(code == Some(Code::SdkRunIdMissing)),
            case["count"].as_u64().unwrap() as usize
        );
    }
}

#[test]
fn native_job_health_detects_stalls_and_corrupt_ownership_without_flagging_scheduled_sleeps() {
    let now: DateTime<Utc> = "2030-01-01T00:00:00Z".parse().unwrap();
    let id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let baseline = Run {
        id,
        workspace_id: "fixture".into(),
        kind: "workspace-invitation-lifecycle-v1".into(),
        state: "running".into(),
        sdk_run_id: Some(format!("forge-native-job:{job_id}")),
        created_at: now - Duration::days(1),
        started_at: Some(now),
        initial: Some(Effect {
            state: "completed".into(),
            completed_at: Some(now),
        }),
        reminder: None,
        job: Some(Job {
            id: job_id,
            kind: "workspace-invitation-lifecycle-v1".into(),
            scope: "fixture".into(),
            identity: id.to_string(),
            state: "queued".into(),
            available_at: now + Duration::days(1),
            lease_until: None,
        }),
    };
    assert_eq!(workflow_health::classify(&baseline, now), None);
    for (state, delay, lease, expected) in [
        ("queued", -299999, None, None),
        ("queued", -300000, None, Some(Code::NativeJobOverdue)),
        ("retry", -300001, None, Some(Code::NativeJobOverdue)),
        ("running", 0, Some(1), None),
        ("running", 0, Some(0), Some(Code::NativeLeaseExpired)),
        ("running", 0, None, Some(Code::NativeLeaseExpired)),
        ("dead", 0, None, Some(Code::NativeJobFailed)),
        ("reconcile", 0, None, Some(Code::NativeJobFailed)),
        ("completed", 0, None, Some(Code::NativeStateMismatch)),
        ("unknown", 0, None, Some(Code::NativeStateMismatch)),
    ] {
        let mut run = baseline.clone();
        let job = run.job.as_mut().unwrap();
        job.state = state.into();
        job.available_at = now + Duration::milliseconds(delay);
        job.lease_until = lease.map(|ms| now + Duration::milliseconds(ms));
        assert_eq!(
            workflow_health::classify(&run, now),
            expected,
            "{state} {delay} {lease:?}"
        );
    }
    for variant in 0..5 {
        let mut run = baseline.clone();
        match variant {
            0 => run.job = None,
            1 => run.job.as_mut().unwrap().scope = "other".into(),
            2 => run.job.as_mut().unwrap().identity = Uuid::new_v4().to_string(),
            3 => run.job.as_mut().unwrap().kind = "other".into(),
            _ => run.sdk_run_id = Some("forge-native-job:not-a-uuid".into()),
        }
        assert_eq!(
            workflow_health::classify(&run, now),
            Some(Code::NativeJobMissing)
        );
    }
    let mut run = baseline;
    run.state = "completed".into();
    run.job = None;
    assert_eq!(workflow_health::classify(&run, now), None);
}
