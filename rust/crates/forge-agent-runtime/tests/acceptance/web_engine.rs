use super::*;
use forge_agent_runtime::web;
struct Web {
    journal: Arc<Memory>,
    calls: AtomicUsize,
}
#[async_trait]
impl web::Transport for Web {
    async fn request(
        &self,
        url: &url::Url,
        accept: &str,
        _: bool,
        _: &Cancellation,
    ) -> std::result::Result<web::Response, web::Failure> {
        let snapshot = self.journal.state.lock().unwrap().snapshot();
        assert_eq!(
            snapshot["calls"][snapshot["next_call"].as_u64().unwrap() as usize]["phase"],
            "calling"
        );
        assert_eq!(url.as_str(), "https://example.com/");
        assert!(accept.starts_with("text/markdown"));
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(web::Response {
            status: 200,
            content_type: "text/html".into(),
            location: None,
            challenge: false,
            body: b"<h1>Reference</h1><p>Checked.</p>".to_vec(),
        })
    }
}
#[tokio::test]
async fn fetched_pages_have_durable_dispatch_and_recoverable_read_receipts() {
    for after in [false, true] {
        let channel = make_channel("owner");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        if after {
            journal.fail_after.store(4, Ordering::SeqCst);
        } else {
            journal.fail_before.store(4, Ordering::SeqCst);
        }
        let model = Arc::new(Scripted::new(vec![vec![call(
            "web_fetch",
            json!({"url":"https://example.com"}),
        )]]));
        let (mut engine, calls) = setup(model.clone(), journal.clone(), None);
        let web = Arc::new(Web {
            journal: journal.clone(),
            calls: AtomicUsize::new(0),
        });
        engine.web = Arc::new(web::Executor {
            transport: web.clone(),
        });
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
        engine
            .drive(
                &channel,
                &mut restored,
                journal.as_ref(),
                &Cancellation::default(),
                deadline(),
            )
            .await
            .unwrap();
        assert_eq!(restored.phase(), Phase::Complete);
        assert_eq!(web.calls.load(Ordering::SeqCst), if after { 1 } else { 2 });
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
        assert!(calls.requests.lock().unwrap().is_empty());
        assert_eq!(restored.snapshot()["workspace"]["provisioned"], false);
        let outputs = journal
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "action.result")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(outputs.len(), 1);
        assert_eq!(
            outputs[0]["data"]["result"]["output"]["value"]["content"],
            "# Reference\n\nChecked."
        );
    }
}
#[tokio::test]
async fn unsafe_urls_are_explicit_tool_errors_without_transport_or_sandbox_effects() {
    let channel = make_channel("owner");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let model = Arc::new(Scripted::new(vec![vec![call(
        "web_fetch",
        json!({"url":"https://127.0.0.1/private"}),
    )]]));
    let (mut engine, calls) = setup(model, journal.clone(), None);
    let web = Arc::new(Web {
        journal: journal.clone(),
        calls: AtomicUsize::new(0),
    });
    engine.web = Arc::new(web::Executor {
        transport: web.clone(),
    });
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
    assert_eq!(web.calls.load(Ordering::SeqCst), 0);
    assert!(calls.requests.lock().unwrap().is_empty());
    assert!(
        state
            .history()
            .iter()
            .any(|m| m.to_string().contains("private, link-local"))
    );
    assert_eq!(state.snapshot()["workspace"]["provisioned"], false);
}
