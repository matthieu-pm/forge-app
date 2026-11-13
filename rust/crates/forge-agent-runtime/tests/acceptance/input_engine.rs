use super::*;

fn question(id: &str, input: Value) -> Value {
    json!({"type":"tool-call","toolCallId":id,"toolName":"ask_question","input":input})
}
fn choices() -> Value {
    json!({"prompt":"Choose a color","options":[{"id":"blue","label":"Blue"},{"id":"red","label":"Red"}]})
}
async fn parked(
    calls: Vec<Value>,
) -> (
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
    let model = Arc::new(Scripted::new(vec![calls]));
    let (engine, effects) = setup(model.clone(), journal.clone(), None);
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
    (channel, state, journal, model, engine, effects)
}
fn successor(user: &str, workspace: &str, provider: &str) -> Channel {
    let secret = "public-engine-fixture-signing-secret";
    let token = mint(secret, Kind::RuntimeChannel, json!({"sub":user,"workspaceId":workspace,"runId":"00000000-0000-4000-8000-000000000002","forgeCapabilityToken":"public-fixture-capability-token","forgeModelAccessToken":"public-fixture-model-access-token","provider":provider,"modelId":"bound-model","reasoningEffort":"medium"}), 1000, 900.).unwrap();
    Channel::verify(secret, &format!("Bearer {token}"), 1001).unwrap()
}
fn outputs(state: &State) -> Vec<Value> {
    state
        .history()
        .iter()
        .filter(|message| message["role"] == "tool")
        .flat_map(|message| message["content"].as_array().unwrap().iter().cloned())
        .collect()
}

#[tokio::test]
async fn a_new_question_batch_can_reuse_a_model_call_id_without_reusing_its_old_answer() {
    let channel = make_channel("owner");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![
        vec![question("reused-id", choices())],
        vec![question(
            "reused-id",
            json!({"prompt":"Choose again","options":[{"id":"red","label":"Red"}]}),
        )],
    ]));
    let (engine, effects) = setup(model.clone(), journal.clone(), None);
    for answer in ["blue", "red"] {
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
        assert!(
            !state.snapshot()["question_answers"]
                .as_object()
                .unwrap()
                .contains_key("reused-id")
        );
        engine
            .resume_questions(
                &channel,
                &mut state,
                journal.as_ref(),
                &[json!({"requestId":"reused-id","optionId":answer})],
            )
            .await
            .unwrap();
        state = journal.load(&channel);
    }
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(
        outputs(&state)
            .iter()
            .map(|result| result["output"]["value"]["optionId"].clone())
            .collect::<Vec<_>>(),
        vec![json!("blue"), json!("red")]
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 3);
    assert!(effects.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mixed_input_batch_defers_typed_answers_until_required_approval_arrives() {
    let (channel, mut state, journal, model, engine, effects) = parked(vec![
        question(RUN, choices()),
        call("list_teams", json!({})),
        call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Renamed"}}),
        ),
        question(
            "opaque-question",
            json!({"prompt":"Optional detail","allowFreeform":false,"options":[]}),
        ),
    ])
    .await;
    assert_eq!(effects.requests.lock().unwrap().len(), 1);
    assert_eq!(state.pending_requests().len(), 3);
    assert_eq!(state.pending_requests()[0]["kind"], "tool-approval");
    assert_eq!(state.pending_questions().len(), 2);
    let approval = state.pending_request().unwrap().to_owned();
    assert!(state.has_required_input());
    assert!(state.issued_request(&approval).is_some());
    assert!(state.issued_request(RUN).is_none());
    assert!(
        engine
            .resume(
                &channel,
                &mut state,
                journal.as_ref(),
                RUN,
                Decision::Approved
            )
            .await
            .is_err()
    );
    let answers = [
        json!({"requestId":RUN,"optionId":"red"}),
        json!({"requestId":RUN,"optionId":"blue","text":""}),
    ];
    engine
        .resume_questions(&channel, &mut state, journal.as_ref(), &answers)
        .await
        .unwrap();
    assert_eq!(state.phase(), Phase::Complete);
    assert_eq!(state.pending_requests().len(), 3);
    assert!(
        state.snapshot()["question_answers"]
            .as_object()
            .unwrap()
            .is_empty()
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
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    engine
        .resume(
            &channel,
            &mut state,
            journal.as_ref(),
            &approval,
            Decision::Denied,
        )
        .await
        .unwrap();
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert!(state.pending_requests().is_empty());
    assert_eq!(effects.requests.lock().unwrap().len(), 1);
    let results = outputs(&state);
    assert_eq!(
        results[0]["output"],
        json!({"type":"json","value":{"status":"answered","optionId":"blue","text":""}})
    );
    assert_eq!(results[2]["output"]["type"], "execution-denied");
    assert_eq!(
        results[3]["output"],
        json!({"type":"json","value":{"status":"ignored"}})
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn question_answers_recover_exactly_once_after_lost_or_failed_journal_commit() {
    for after in [false, true] {
        let (channel, mut state, journal, _, engine, effects) =
            parked(vec![question("question", json!({"prompt":"Detail?"}))]).await;
        let answer = [json!({"requestId":"question","text":"retain this exact answer"})];
        let fail = journal.commits.load(Ordering::SeqCst) + 1;
        if after {
            journal.fail_after.store(fail, Ordering::SeqCst);
        } else {
            journal.fail_before.store(fail, Ordering::SeqCst);
        }
        assert!(
            engine
                .resume_questions(&channel, &mut state, journal.as_ref(), &answer)
                .await
                .is_err()
        );
        assert!(effects.requests.lock().unwrap().is_empty());
        state = journal.load(&channel);
        engine
            .resume_questions(&channel, &mut state, journal.as_ref(), &answer)
            .await
            .unwrap();
        assert_eq!(
            journal
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event["type"] == "action.result")
                .count(),
            1
        );
        engine
            .drive(
                &channel,
                &mut state,
                journal.as_ref(),
                &Cancellation::default(),
                deadline(),
            )
            .await
            .unwrap();
        assert_eq!(
            outputs(&state)[0]["output"]["value"]["text"],
            "retain this exact answer"
        );
    }
}

#[tokio::test]
async fn question_snapshot_rejects_forged_kind_binding_receipt_and_boolean_authority() {
    let (channel, state, journal, _, engine, _) = parked(vec![question(RUN, choices())]).await;
    for (path, value) in [
        (vec!["questions", "0", "kind"], json!("tool-approval")),
        (vec!["questions", "0", "requestId"], json!("different")),
        (
            vec!["questions", "0", "action", "input", "prompt"],
            json!("Altered"),
        ),
        (vec!["calls", "0", "decision"], json!("approved")),
        (vec!["calls", "0", "input_hash"], json!("0".repeat(64))),
        (vec!["calls", "0", "phase"], json!("calling")),
    ] {
        let mut snapshot = state.snapshot();
        let mut cursor = &mut snapshot;
        for key in path {
            cursor = if cursor.is_array() {
                &mut cursor[key.parse::<usize>().unwrap()]
            } else {
                &mut cursor[key]
            };
        }
        *cursor = value;
        assert!(State::restore(snapshot, &channel).is_err());
    }
    let mut state = state;
    for answers in [
        vec![],
        vec![json!({"requestId":"unknown","text":"answer"})],
        vec![json!({"requestId":RUN,"text":true})],
        vec![json!({"requestId":RUN,"approved":true})],
    ] {
        assert!(
            engine
                .resume_questions(&channel, &mut state, journal.as_ref(), &answers)
                .await
                .is_err()
        );
    }
    engine
        .resume_questions(
            &channel,
            &mut state,
            journal.as_ref(),
            &[json!({"requestId":RUN})],
        )
        .await
        .unwrap();
    assert_eq!(
        state.snapshot()["question_answers"][RUN],
        json!({"status":"answered"})
    );
}

#[tokio::test]
async fn composer_attachment_content_stays_intact_and_preserves_parent_usage() {
    let (_, state, _, _, _, _) = parked(vec![
        question("color", choices()),
        question(
            "different",
            json!({"prompt":"Other?","options":[{"id":"unmatched","label":"Different"}]}),
        ),
    ])
    .await;
    let child = successor("owner", "workspace", "anthropic");
    let attachment = json!({"type":"file","data":{"type":"data","data":"JVBERi0xLjQK"},"mediaType":"application/pdf","filename":"context.pdf"});
    let message = json!({"role":"user","content":[{"type":"text","text":" BLUE "},attachment]});
    let (next, events) = state
        .question_continuation(&child, message, false)
        .unwrap()
        .unwrap();
    assert_eq!(next.revision(), 0);
    assert_eq!(next.phase(), Phase::Ready);
    assert_eq!(events.len(), 2);
    assert_eq!(
        next.snapshot()["budget"]["prior"],
        json!({"input":10,"output":5})
    );
    assert_eq!(next.usage(), (0, 0));
    assert_eq!(
        next.history().last().unwrap(),
        &json!({"role":"user","content":[{"type":"text","text":" BLUE "},attachment]})
    );
    let results = outputs(&next);
    assert_eq!(results[0]["output"]["value"], json!({"status":"ignored"}));
    assert_eq!(results[1]["output"]["value"], json!({"status":"ignored"}));
    State::restore(next.snapshot(), &child).unwrap();
    assert!(
        state
            .question_continuation(
                &successor("other", "workspace", "openai"),
                json!({"role":"user","content":"Blue"}),
                false
            )
            .is_err()
    );
    assert!(
        state
            .question_continuation(
                &successor("owner", "other", "openai"),
                json!({"role":"user","content":"Blue"}),
                false
            )
            .is_err()
    );
}

#[tokio::test]
async fn cancelled_parent_retains_model_questions_and_completed_read_results() {
    let (_, state, _, _, _, effects) = parked(vec![
        question("question", choices()),
        call("get_team", json!({"slug":"forge"})),
    ])
    .await;
    assert_eq!(effects.requests.lock().unwrap().len(), 1);
    let child = successor("owner", "workspace", "openai");
    let message = json!({"role":"user","content":"Please change the subject"});
    let (next, events) = state
        .question_continuation(&child, message.clone(), true)
        .unwrap()
        .unwrap();
    assert_eq!(next.phase(), Phase::Ready);
    assert_eq!(next.history().last(), Some(&message));
    assert_eq!(
        outputs(&next)[0]["output"]["value"],
        json!({"status":"ignored"})
    );
    assert_eq!(outputs(&next)[1]["output"]["type"], "json");
    assert_eq!(
        events
            .iter()
            .filter(|event| event["data"]["status"] == "rejected")
            .count(),
        0
    );
}

#[tokio::test]
async fn nonmatching_composer_queues_without_effects_and_canonical_delivery_uses_latest_history() {
    use forge_agent_runtime::engine::InputDelivery;
    let (channel, state, _, model, _, effects) = parked(vec![
        question("question", choices()),
        call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Requires approval"}}),
        ),
    ])
    .await;
    let request = state.pending_request().unwrap().to_owned();
    let child = successor("owner", "workspace", "anthropic");
    let message = json!({"role":"user","content":"Different subject"});
    let Some(InputDelivery::Deferred {
        owner,
        delivery,
        events,
    }) = state.compose_input(&child, message.clone(), false).unwrap()
    else {
        panic!("must defer")
    };
    assert_eq!(owner.revision(), state.revision() + 1);
    assert_eq!(owner.phase(), Phase::Waiting);
    assert_eq!(delivery.phase(), Phase::Complete);
    assert_eq!(delivery.revision(), 0);
    assert!(delivery.pending_requests().is_empty());
    assert_eq!(delivery.usage(), (0, 0));
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["turn.started", "turn.completed", "session.waiting"]
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert!(effects.requests.lock().unwrap().is_empty());
    let (mut resumed, _) = owner
        .canonical_input(&channel, &state, &request, Decision::Denied)
        .unwrap();
    assert_eq!(resumed.usage(), state.usage());
    assert_eq!(resumed.session_usage(), state.session_usage());
    let journal = Arc::new(Memory::new(resumed.clone()));
    let followup = Arc::new(Scripted::new(vec![]));
    let (engine, calls) = setup(followup.clone(), journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut resumed,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert!(calls.requests.lock().unwrap().is_empty());
    assert_eq!(
        followup.prompts.lock().unwrap()[0].last(),
        Some(&json!({"role":"user","content":[{"type":"text","text":"Different subject"}]}))
    );
    assert!(resumed.history().iter().any(|stored| stored == &message));
    assert_eq!(resumed.usage(), (20, 10));
    assert_eq!(resumed.session_usage(), (20, 10));
}

#[tokio::test]
async fn two_required_decisions_are_atomic_and_queued_responses_suppress_composer_matching() {
    use forge_agent_runtime::engine::InputDelivery;
    let mut second = call(
        "update_team",
        json!({"slug":"forge","settings":{"name":"Second"}}),
    );
    second["toolCallId"] = json!("second-write");
    let (channel, mut state, journal, model, engine, effects) = parked(vec![
        call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"First"}}),
        ),
        second,
        question("color", choices()),
    ])
    .await;
    let requests = state.pending_requests();
    let first = requests[0]["requestId"].as_str().unwrap();
    let second = requests[1]["requestId"].as_str().unwrap();
    engine
        .resume(
            &channel,
            &mut state,
            journal.as_ref(),
            first,
            Decision::Denied,
        )
        .await
        .unwrap();
    assert_eq!(state.phase(), Phase::Complete);
    assert!(state.has_required_input());
    assert!(
        state.snapshot()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|call| call["decision"].is_null())
    );
    let revision = state.revision();
    engine
        .resume(
            &channel,
            &mut state,
            journal.as_ref(),
            first,
            Decision::Denied,
        )
        .await
        .unwrap();
    assert_eq!(state.revision(), revision);
    let child = successor("owner", "workspace", "openai");
    let Some(InputDelivery::Deferred {
        owner, delivery, ..
    }) = state
        .compose_input(&child, json!({"role":"user","content":"Approve"}), false)
        .unwrap()
    else {
        panic!("queued explicit response suppresses matching")
    };
    assert_eq!(delivery.phase(), Phase::Complete);
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert!(effects.requests.lock().unwrap().is_empty());
    let (mut next, _) = owner
        .canonical_input(&channel, &state, second, Decision::Denied)
        .unwrap();
    assert!(next.pending_requests().is_empty());
    let journal = Arc::new(Memory::new(next.clone()));
    let followup = Arc::new(Scripted::new(vec![]));
    let (engine, calls) = setup(followup.clone(), journal.clone(), None);
    engine
        .drive(
            &channel,
            &mut next,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert!(calls.requests.lock().unwrap().is_empty());
    assert_eq!(
        followup.prompts.lock().unwrap()[0].last(),
        Some(&json!({"role":"user","content":[{"type":"text","text":"Approve"}]}))
    );
    assert!(
        next.history()
            .iter()
            .any(|stored| stored == &json!({"role":"user","content":"Approve"}))
    );
    assert_eq!(outputs(&next)[2]["output"]["value"]["status"], "ignored");
}

#[tokio::test]
async fn composer_resolution_never_claims_old_request_provenance_and_old_run_rebind_keeps_session_usage()
 {
    use forge_agent_runtime::engine::InputDelivery;
    let (_, state, _, _, _, _) = parked(vec![call(
        "update_team",
        json!({"slug":"forge","settings":{"name":"No write"}}),
    )])
    .await;
    let request = state.pending_request().unwrap().to_owned();
    let child = successor("owner", "workspace", "anthropic");
    let Some(InputDelivery::Resolved {
        state: mut latest, ..
    }) = state
        .compose_input(&child, json!({"role":"user","content":"Deny"}), false)
        .unwrap()
    else {
        panic!("must match")
    };
    assert!(latest.issued_request(&request).is_none());
    let journal = Arc::new(Memory::new(latest.clone()));
    let model = Arc::new(Scripted::new(vec![]));
    let (engine, effects) = setup(model, journal.clone(), None);
    engine
        .drive(
            &child,
            &mut latest,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(latest.usage(), (10, 5));
    assert_eq!(latest.session_usage(), (20, 10));
    assert!(effects.requests.lock().unwrap().is_empty());
    let rebound_channel = make_provider_channel("owner", "anthropic");
    let (mut resumed, _) = latest
        .canonical_input(&rebound_channel, &state, &request, Decision::Approved)
        .unwrap();
    assert_eq!(resumed.usage(), (10, 5));
    assert_eq!(resumed.session_usage(), (20, 10));
    assert_eq!(
        &resumed.history()[..latest.history().len()],
        latest.history()
    );
    let stale = resumed.history().last().unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(stale.starts_with(
        "The user submitted the following response to an earlier interactive prompt."
    ));
    assert!(stale.contains("This does not authorize an earlier action"));
    assert!(stale.contains("Approve tool call: update_team"));
    assert!(stale.contains("\"label\": \"Yes\""));
    assert!(stale.contains(&request));
    assert!(resumed.issued_request(&request).is_some());
    let journal = Arc::new(Memory::new(resumed.clone()));
    let model = Arc::new(Scripted::new(vec![]));
    let (engine, effects) = setup(model, journal.clone(), None);
    engine
        .drive(
            &rebound_channel,
            &mut resumed,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(resumed.usage(), (20, 10));
    assert_eq!(resumed.session_usage(), (30, 15));
    assert!(effects.requests.lock().unwrap().is_empty());
}

struct OriginalRunLedger {
    journal: Arc<Memory>,
    attempted_runs: Mutex<Vec<String>>,
}
#[async_trait]
impl Capabilities for OriginalRunLedger {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value> {
        let snapshot = self.journal.state.lock().unwrap().snapshot();
        let cursor = snapshot["next_call"].as_u64().unwrap() as usize;
        assert_eq!(snapshot["calls"][cursor]["phase"], "calling");
        assert_eq!(request.id, "teams.update");
        self.attempted_runs
            .lock()
            .unwrap()
            .push(channel.run_id().to_owned());
        // The application issued the grant to A. The runtime may only present
        // the current delivery B's credentials, which cannot spend that grant.
        if channel.run_id() != RUN {
            return Err(Error("APPROVAL_NOT_FOUND"));
        }
        panic!("this fixture must never dispatch under the original run");
    }
}
#[tokio::test]
async fn matching_composer_executes_under_its_own_channel_and_cannot_borrow_the_original_grant() {
    use forge_agent_runtime::engine::InputDelivery;
    let (_, state, _, _, _, _) = parked(vec![call(
        "update_team",
        json!({"slug":"forge","settings":{"name":"Never authorized for B"}}),
    )])
    .await;
    let child = successor("owner", "workspace", "openai");
    let Some(InputDelivery::Resolved {
        state: mut next, ..
    }) = state
        .compose_input(&child, json!({"role":"user","content":"yes"}), false)
        .unwrap()
    else {
        panic!("must resolve")
    };
    let journal = Arc::new(Memory::new(next.clone()));
    let ledger = Arc::new(OriginalRunLedger {
        journal: journal.clone(),
        attempted_runs: Mutex::new(vec![]),
    });
    let engine = Engine::new(
        Arc::new(Scripted::new(vec![])),
        Arc::new(Executor {
            capabilities: ledger.clone(),
            sandbox: None,
            features: Features::default(),
        }),
    );
    engine
        .drive(
            &child,
            &mut next,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(
        ledger.attempted_runs.lock().unwrap().as_slice(),
        &[child.run_id().to_owned()]
    );
    assert_eq!(
        outputs(&next)[0]["output"],
        json!({"type":"error-text","value":"APPROVAL_NOT_FOUND"})
    );
}

#[tokio::test]
async fn legacy_pending_snapshot_migrates_original_provenance_but_new_snapshot_cannot_invent_a_request()
 {
    let (channel, state, _, _, _, _) = parked(vec![call(
        "update_team",
        json!({"slug":"forge","settings":{"name":"Legacy"}}),
    )])
    .await;
    let request = state.pending_request().unwrap().to_owned();
    let mut snapshot = state.snapshot();
    snapshot.as_object_mut().unwrap().remove("pending_input");
    snapshot.as_object_mut().unwrap().remove("issued_requests");
    let restored = State::restore(snapshot, &channel).unwrap();
    assert_eq!(
        restored.issued_request(&request),
        state.issued_request(&request)
    );
    let mut invalid = state.snapshot();
    invalid["pending_input"]["batch"]["requests"][0]["action"]["input"]["slug"] = json!("other");
    assert!(State::restore(invalid, &channel).is_err());
}

#[tokio::test]
async fn cancelled_required_batch_cannot_be_revived_by_matching_composer_text() {
    let (_, state, _, _, _, _) = parked(vec![
        question("question", choices()),
        call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Cancelled write"}}),
        ),
    ])
    .await;
    let child = successor("owner", "workspace", "openai");
    for text in ["yes", "different subject"] {
        assert!(
            state
                .compose_input(&child, json!({"role":"user","content":text}), true)
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn repeated_model_call_ids_keep_distinct_historical_approval_metadata_out_of_provider_requests()
 {
    let channel = make_channel("owner");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![
        vec![call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"First"}}),
        )],
        vec![call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Second"}}),
        )],
    ]));
    let (engine, effects) = setup(model, journal.clone(), None);
    let mut requests = vec![];
    for _ in 0..2 {
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
        let request = state.pending_request().unwrap().to_owned();
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
        requests.push(request);
    }
    engine
        .drive(
            &channel,
            &mut state,
            journal.as_ref(),
            &Cancellation::default(),
            deadline(),
        )
        .await
        .unwrap();
    assert_ne!(requests[0], requests[1]);
    let metadata = state
        .history()
        .iter()
        .filter(|message| message["role"] == "assistant")
        .filter_map(|message| message["content"].as_array())
        .flat_map(|parts| {
            parts
                .iter()
                .filter(|part| part["type"] == "tool-approval-request")
        })
        .collect::<Vec<_>>();
    assert_eq!(metadata.len(), 2);
    for (index, part) in metadata.iter().enumerate() {
        assert_eq!(part["approvalId"], requests[index]);
        assert_eq!(part["toolCallId"], "call_update_team");
    }
    for provider in ["openai", "anthropic", "mistral"] {
        let request = forge_agent_runtime::model::request::build(
            &make_provider_channel("owner", provider),
            state.history(),
            &[],
            None,
        )
        .unwrap();
        let body = request.body.to_string();
        assert!(!body.contains("tool-approval-request"));
        assert!(!body.contains(&requests[0]));
        assert!(!body.contains(&requests[1]));
    }
    assert!(effects.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_calling_and_queued_tools_become_history_without_replaying_committed_effects() {
    let write = |id: &str| json!({"type":"tool-call","toolCallId":id,"toolName":"update_team","input":{"slug":"forge","settings":{"name":id}}});
    let (a,parked,_,_,_,_)=parked(vec![write("ambiguous-write"),write("unstarted-write"),json!({"type":"tool-call","toolCallId":"completed-read","toolName":"get_team","input":{"slug":"forge"}})]).await;
    let mut saved = parked.snapshot();
    saved["phase"] = json!("tools");
    saved["next_call"] = json!(0);
    saved["pending_input"]["batch"] = Value::Null;
    for (index, phase) in [(0, "calling"), (1, "queued")] {
        saved["calls"][index]["phase"] = json!(phase);
        saved["calls"][index]["decision"] = json!("approved");
        let id = saved["calls"][index]["request_id"]
            .as_str()
            .unwrap()
            .to_owned();
        saved["decisions"][&id] = json!("approved");
    }
    saved["pending_input"]["deferredInput"] = json!({"message":"Keep this queued message"});
    let active = State::restore(saved, &a).unwrap();
    let settled = active.settle_cancelled_inputs(&[]).unwrap();
    assert_eq!(settled.session_usage(), active.session_usage());
    assert_eq!(settled.phase(), Phase::Ready);
    let parts = outputs(&settled);
    assert!(parts.iter().any(|part| {
        part["toolCallId"] == "ambiguous-write"
            && part["output"]["reason"]
                .as_str()
                .unwrap()
                .contains("unknown")
    }));
    assert!(
        parts
            .iter()
            .any(|part| part["toolCallId"] == "unstarted-write"
                && part["output"]["type"] == "execution-denied")
    );
    assert_eq!(
        parts
            .iter()
            .find(|part| part["toolCallId"] == "completed-read")
            .unwrap()["output"],
        active.snapshot()["calls"][2]["output"]
    );
    let c = successor("owner", "workspace", "anthropic");
    let original = initial(&c);
    let old = parked.pending_requests()[0]["requestId"].clone();
    let (mut resumed, _) = settled
        .canonical_inputs(
            &c,
            &original,
            &[json!({"requestId":old,"optionId":"approve"})],
        )
        .unwrap();
    assert!(resumed.history().iter().any(|message| {
        message["role"] == "user"
            && message["content"]
                .as_str()
                .is_some_and(|text| text.contains("Keep this queued message"))
    }));
    let journal = Arc::new(Memory::new(resumed.clone()));
    let model = Arc::new(Scripted::new(vec![]));
    let (engine, effects) = setup(model, journal.clone(), None);
    assert_eq!(
        engine
            .drive(
                &c,
                &mut resumed,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .unwrap(),
        Phase::Complete
    );
    assert!(effects.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_projection_retains_proven_earlier_input_and_questions_but_discards_own_write() {
    let write = |id: &str| json!({"type":"tool-call","toolCallId":id,"toolName":"update_team","input":{"slug":"forge","settings":{"name":id}}});
    let (a, original, _, _, _, _) = parked(vec![
        write("earlier-a"),
        write("cancelled-b"),
        question("ordinary-question", json!({"prompt":"Anything else?"})),
    ])
    .await;
    let requests = original.pending_requests();
    let retained = requests[0]["requestId"].as_str().unwrap().to_owned();
    let mut saved = original.snapshot();
    let b = successor("owner", "workspace", "anthropic");
    saved["binding"]["run"] = json!(b.run_id());
    saved["binding"]["provider"] = json!(b.provider());
    saved["issued_requests"]
        .as_object_mut()
        .unwrap()
        .remove(&retained);
    saved["pending_input"]["deferredInput"] = json!({"message":"Deferred message"});
    let owner = State::restore(saved, &b).unwrap();
    let settled = owner
        .settle_cancelled_inputs(std::slice::from_ref(&retained))
        .unwrap();
    assert_eq!(settled.pending_requests().len(), 2);
    assert_eq!(settled.pending_questions().len(), 1);
    assert_eq!(
        settled.snapshot()["calls"][1]["output"]["type"],
        "execution-denied"
    );
    assert_eq!(
        settled.snapshot()["pending_input"]["deferredInput"]["message"],
        "Deferred message"
    );
    let (resumed, _) = settled
        .canonical_inputs(
            &a,
            &original,
            &[json!({"requestId":retained,"optionId":"deny"})],
        )
        .unwrap();
    assert_eq!(resumed.session_usage(), owner.session_usage());
    assert!(resumed.pending_requests().is_empty());
    assert_eq!(
        resumed.snapshot()["calls"][1]["output"]["type"],
        "execution-denied"
    );
    assert_eq!(
        resumed.snapshot()["calls"][2]["output"]["value"]["status"],
        "ignored"
    );
}
