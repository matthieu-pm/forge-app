use super::*;
#[tokio::test]
async fn task_list_and_tool_receipt_survive_lost_commit_acknowledgements() {
    let todos = json!([{ "content":"Finish the rewrite","status":"in_progress","priority":"high"}]);
    for after in [false, true] {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        if after {
            journal.fail_after.store(3, Ordering::SeqCst);
        } else {
            journal.fail_before.store(3, Ordering::SeqCst);
        }
        let model = Arc::new(Scripted::new(vec![
            vec![call("todo", json!({"todos":todos}))],
            vec![call("todo", json!({}))],
        ]));
        let calls = Arc::new(Calls {
            journal: journal.clone(),
            requests: Mutex::new(vec![]),
        });
        let engine = Engine::new(
            model.clone(),
            Arc::new(Executor {
                capabilities: calls.clone(),
                sandbox: None,
                features: Features::default(),
            }),
        );
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
        let mut restored = journal.load(&channel);
        assert_eq!(
            restored.snapshot()["todos"],
            if after { todos.clone() } else { json!([]) }
        );
        assert_eq!(
            engine
                .drive(
                    &channel,
                    &mut restored,
                    journal.as_ref(),
                    &Cancellation::default(),
                    deadline()
                )
                .await
                .unwrap(),
            Phase::Complete
        );
        assert_eq!(restored.snapshot()["todos"], todos);
        let results = journal
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "action.result")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(result["data"]["result"]["output"]["value"]["todos"], todos);
        }
        assert!(calls.requests.lock().unwrap().is_empty());
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            3,
            "a persisted model response must not be regenerated"
        );
    }
}
#[test]
fn legacy_context_defaults_and_invalid_task_lists_are_checked() {
    let channel = make_channel("owner");
    let state = initial(&channel);
    let mut legacy = state.snapshot();
    legacy.as_object_mut().unwrap().remove("todos");
    assert_eq!(
        State::restore(legacy, &channel).unwrap().snapshot()["todos"],
        json!([])
    );
    for invalid in [
        Value::Null,
        json!([{"content":"task","priority":"urgent","status":"pending"}]),
        json!([{"content":"task","priority":"high","status":"pending","extra":true}]),
    ] {
        let mut snapshot = state.snapshot();
        snapshot["todos"] = invalid;
        assert!(State::restore(snapshot, &channel).is_err());
    }
}
