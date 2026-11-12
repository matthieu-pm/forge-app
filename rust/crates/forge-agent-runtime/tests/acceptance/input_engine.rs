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
async fn ordinary_question_batch_is_typed_and_does_not_authorize_queued_effects() {
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
    assert!(effects.requests.lock().unwrap().is_empty());
    let requests = state.pending_questions();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["requestId"], RUN);
    assert_eq!(requests[0]["kind"], "question");
    assert_eq!(requests[0]["display"], "select");
    assert!(requests[0].get("allowFreeform").is_none());
    assert_eq!(requests[1]["display"], "select");
    assert_eq!(
        journal
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "input.requested")
            .count(),
        1
    );
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
    let revision = state.revision();
    engine
        .resume_questions(&channel, &mut state, journal.as_ref(), &answers)
        .await
        .unwrap();
    assert_eq!(state.revision(), revision);
    assert!(
        engine
            .resume_questions(
                &channel,
                &mut state,
                journal.as_ref(),
                &[json!({"requestId":RUN,"optionId":"red"})]
            )
            .await
            .is_err()
    );
    assert!(
        engine
            .resume(
                &channel,
                &mut state,
                journal.as_ref(),
                RUN,
                Decision::Denied
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
    assert!(state.pending_questions().is_empty());
    assert_eq!(effects.requests.lock().unwrap().len(), 1);
    let approval = state.pending_request().unwrap().to_owned();
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
    assert_eq!(effects.requests.lock().unwrap().len(), 1);
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
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
async fn composer_consumes_matching_text_keeps_attachments_and_preserves_parent_usage() {
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
        &json!({"role":"user","content":[attachment]})
    );
    let results = outputs(&next);
    assert_eq!(
        results[0]["output"]["value"],
        json!({"status":"answered","optionId":"blue"})
    );
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
async fn cancelled_parent_questions_survive_but_unfinished_tools_stay_denied() {
    let (_, state, _, _, _, effects) = parked(vec![
        question("question", choices()),
        call("get_team", json!({"slug":"forge"})),
        call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Never execute"}}),
        ),
    ])
    .await;
    let child = successor("owner", "workspace", "openai");
    let message =
        json!({"role":"user","content":[{"type":"text","text":"Please change the subject"}]});
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
    assert!(
        outputs(&next)
            .iter()
            .skip(1)
            .all(|result| result["output"]["type"] == "execution-denied")
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["data"]["status"] == "rejected")
            .count(),
        2
    );
    assert!(effects.requests.lock().unwrap().is_empty());
    let journal = Arc::new(Memory::new(next.clone()));
    let model = Arc::new(Scripted::new(vec![]));
    let (engine, calls) = setup(model, journal.clone(), None);
    let mut next = next;
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
    assert!(calls.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn normal_composer_successor_keeps_unrelated_queue_and_orders_followup_after_results() {
    let (_, state, _, _, _, _) = parked(vec![
        question("question", choices()),
        call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Requires approval"}}),
        ),
    ])
    .await;
    let child = successor("owner", "workspace", "openai");
    let message = json!({"role":"user","content":[{"type":"text","text":"Different subject"}]});
    let (mut next, events) = state
        .question_continuation(&child, message.clone(), false)
        .unwrap()
        .unwrap();
    assert_eq!(next.phase(), Phase::Tools);
    assert_eq!(events[0]["type"], "turn.started");
    assert_eq!(next.snapshot()["question_followup"], message);
    let journal = Arc::new(Memory::new(next.clone()));
    let model = Arc::new(Scripted::new(vec![]));
    let (engine, effects) = setup(model.clone(), journal.clone(), None);
    assert_eq!(
        engine
            .drive(
                &child,
                &mut next,
                journal.as_ref(),
                &Cancellation::default(),
                deadline()
            )
            .await
            .unwrap(),
        Phase::Waiting
    );
    assert!(effects.requests.lock().unwrap().is_empty());
    let approval = next.pending_request().unwrap().to_owned();
    engine
        .resume(
            &child,
            &mut next,
            journal.as_ref(),
            &approval,
            Decision::Denied,
        )
        .await
        .unwrap();
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
    assert!(effects.requests.lock().unwrap().is_empty());
    let prompts = model.prompts.lock().unwrap();
    let prompt = &prompts[0];
    assert_eq!(prompt.last(), Some(&message));
    assert_eq!(prompt[prompt.len() - 2]["role"], "tool");
    assert_eq!(
        prompt[prompt.len() - 2]["content"][1]["output"]["type"],
        "execution-denied"
    );
    assert!(next.snapshot()["question_followup"].is_null());
}
