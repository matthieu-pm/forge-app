use super::*;

async fn parked() -> (
    Channel,
    State,
    Arc<Memory>,
    Arc<Scripted>,
    Engine,
    Arc<Calls>,
) {
    let channel = make_channel("owner");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![call(
        "describe_workspace",
        json!({}),
    )]]));
    let (mut engine, calls) = setup(model.clone(), journal.clone(), None);
    engine.max_input_tokens = 10;
    assert_eq!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    (channel, state, journal, model, engine, calls)
}
#[tokio::test]
async fn allowance_requests_and_decisions_recover_without_regranting_or_repeating_tools() {
    for after in [false, true] {
        let (channel, mut state, journal, model, mut engine, calls) = parked().await;
        let request = state.pending_request().unwrap().to_owned();
        let approval = journal
            .normalized()
            .into_iter()
            .find(|v| v["type"] == "approval.requested")
            .unwrap();
        assert_eq!(
            approval["payload"]["capabilityId"],
            "eve.tool.session_limit_continuation"
        );
        assert_eq!(
            approval["payload"]["input"],
            json!({"kind":"input","limit":10,"usedTokens":10})
        );
        engine
            .resume(
                &channel,
                &mut state,
                journal.as_ref(),
                &request,
                Decision::Approved,
            )
            .await
            .unwrap();
        let fail = journal.commits.load(Ordering::SeqCst) + 1;
        if after {
            journal.fail_after.store(fail, Ordering::SeqCst);
        } else {
            journal.fail_before.store(fail, Ordering::SeqCst);
        }
        // A changed deployment cannot change the amount already offered.
        engine.max_input_tokens = 1000;
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
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        state = journal.load(&channel);
        engine
            .resume(
                &channel,
                &mut state,
                journal.as_ref(),
                &request,
                Decision::Approved,
            )
            .await
            .unwrap();
        assert!(
            engine
                .resume(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &request,
                    Decision::Denied
                )
                .await
                .is_err()
        );
        assert_eq!(
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .unwrap(),
            Phase::Complete
        );
        assert_eq!(
            state.snapshot()["budget"]["granted"],
            json!({"input":20,"output":50005})
        );
        assert_eq!(state.session_usage(), (20, 10));
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
        assert_eq!(calls.requests.lock().unwrap().len(), 1);
        assert_eq!(
            journal
                .normalized()
                .iter()
                .filter(|v| v["type"] == "approval.requested")
                .count(),
            1
        );
    }
}
#[tokio::test]
async fn declining_an_allowance_ends_the_turn_without_more_model_or_tool_work() {
    let (channel, mut state, journal, model, engine, calls) = parked().await;
    let request = state.pending_request().unwrap().to_owned();
    assert!(
        engine
            .resume(
                &channel,
                &mut state,
                journal.as_ref(),
                &uuid::Uuid::new_v4().to_string(),
                Decision::Approved
            )
            .await
            .is_err()
    );
    engine
        .resume(
            &channel,
            &mut state,
            journal.as_ref(),
            &request,
            Decision::Denied,
        )
        .await
        .unwrap();
    state = journal.load(&channel);
    assert_eq!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .unwrap(),
        Phase::Cancelled
    );
    engine
        .resume(
            &channel,
            &mut state,
            journal.as_ref(),
            &request,
            Decision::Denied,
        )
        .await
        .unwrap();
    assert!(state.snapshot()["budget"]["granted"].is_null());
    assert!(state.snapshot()["budget"]["pending"].is_null());
    assert_eq!(state.session_usage(), (10, 5));
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    let events = journal.normalized();
    assert!(events.iter().any(|e| e["type"] == "run.cancelled"));
    assert!(!events.iter().any(|e| e["type"] == "run.completed"));
}
#[tokio::test]
async fn allowance_parking_survives_before_and_after_commit_failures() {
    for after in [false, true] {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let mut snapshot = state.snapshot();
        snapshot["budget"]["prior"] = json!({"input":200000,"output":50000});
        state = State::restore(snapshot, &channel).unwrap();
        let journal = Arc::new(Memory::new(state.clone()));
        let model = Arc::new(Scripted::new(vec![]));
        let (engine, calls) = setup(model.clone(), journal.clone(), None);
        if after {
            journal.fail_after.store(1, Ordering::SeqCst);
        } else {
            journal.fail_before.store(1, Ordering::SeqCst);
        }
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
        state = journal.load(&channel);
        assert_eq!(
            engine
                .drive(
                    &channel,
                    &mut state,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .unwrap(),
            Phase::Waiting
        );
        assert_eq!(state.snapshot()["budget"]["pending"]["kind"], "input");
        assert_eq!(
            journal
                .normalized()
                .iter()
                .filter(|e| e["type"] == "approval.requested")
                .count(),
            1
        );
        assert_eq!(model.calls.load(Ordering::SeqCst), 0);
        assert!(calls.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn output_exhaustion_is_separate_and_forged_continuations_are_rejected() {
    let channel = make_channel("owner");
    let mut snapshot = initial(&channel).snapshot();
    snapshot["budget"]["prior"] = json!({"input":4,"output":50000});
    let mut state = State::restore(snapshot, &channel).unwrap();
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![]));
    let (engine, _) = setup(model.clone(), journal.clone(), None);
    assert_eq!(
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    assert_eq!(state.snapshot()["budget"]["pending"]["kind"], "output");
    for (key, value) in [
        ("request_id", json!("not-a-uuid")),
        ("used_tokens", json!(49999)),
        ("limit", json!(1)),
        ("resume", json!("tools")),
        ("decision", json!("approved")),
        ("grant", json!({"input":4,"output":100000})),
    ] {
        let mut invalid = state.snapshot();
        invalid["budget"]["pending"][key] = value;
        assert!(State::restore(invalid, &channel).is_err(), "{key}");
    }
    let mut invalid = state.snapshot();
    invalid["budget"]["prior"]["input"] = json!(9007199254740991_u64);
    invalid["input_tokens"] = json!(1);
    assert!(State::restore(invalid, &channel).is_err());
    // The internal continuation name must not become an advertised model tool.
    let mut fresh = initial(&channel);
    let journal = Arc::new(Memory::new(fresh.clone()));
    let model = Arc::new(Scripted::new(vec![vec![call(
        "session_limit_continuation",
        json!({"kind":"input","limit":999,"usedTokens":0}),
    )]]));
    let (engine, _) = setup(model, journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut fresh,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert!(fresh.snapshot()["budget"]["granted"].is_null());
    assert!(
        !journal
            .normalized()
            .iter()
            .any(|e| e["type"] == "approval.requested")
    );
}
