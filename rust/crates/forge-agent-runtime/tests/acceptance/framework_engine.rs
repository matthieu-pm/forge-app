use super::*;
use forge_agent_runtime::{sandbox::Workspace, workspace};
use std::collections::BTreeMap;
use uuid::Uuid;
struct Provider {
    journal: Arc<Memory>,
    files: Arc<Mutex<Option<BTreeMap<String, String>>>>,
    opens: Mutex<Vec<(Uuid, bool)>>,
    writes: Arc<AtomicUsize>,
    runs: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    unavailable: bool,
}
impl Provider {
    fn new(journal: Arc<Memory>) -> Self {
        Self {
            journal,
            files: Arc::new(Mutex::new(None)),
            opens: Mutex::new(vec![]),
            writes: Arc::new(AtomicUsize::new(0)),
            runs: Arc::new(AtomicUsize::new(0)),
            dropped: Arc::new(AtomicUsize::new(0)),
            unavailable: false,
        }
    }
}
#[async_trait]
impl workspace::Factory for Provider {
    async fn open(&self, key: Uuid, create: bool) -> Result<Arc<dyn Workspace>> {
        let state = self.journal.state.lock().unwrap().snapshot();
        assert_eq!(state["workspace"]["key"], key.to_string());
        assert_eq!(state["workspace"]["provisioned"], !create);
        self.opens.lock().unwrap().push((key, create));
        if self.unavailable {
            return Err(Error("Fixture provider unavailable."));
        }
        let mut files = self.files.lock().unwrap();
        if files.is_none() {
            if !create {
                return Err(Error("Missing established workspace."));
            }
            *files = Some(BTreeMap::from([("/workspace/a".into(), "original".into())]));
        }
        Ok(Arc::new(Handle {
            identity: format!("native-workspace:{key}"),
            journal: self.journal.clone(),
            files: self.files.clone(),
            writes: self.writes.clone(),
            runs: self.runs.clone(),
            dropped: self.dropped.clone(),
        }))
    }
}
struct Handle {
    identity: String,
    journal: Arc<Memory>,
    files: Arc<Mutex<Option<BTreeMap<String, String>>>>,
    writes: Arc<AtomicUsize>,
    runs: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
impl Handle {
    fn before_effect(&self) {
        let state = self.journal.state.lock().unwrap().snapshot();
        assert_eq!(state["workspace"]["provisioned"], true);
        let next = state["next_call"].as_u64().unwrap() as usize;
        assert_eq!(state["calls"][next]["phase"], "calling");
    }
}
#[async_trait]
impl Sandbox for Handle {
    async fn write(&self, path: &str, content: &str) -> Result<()> {
        self.before_effect();
        self.files
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .insert(format!("/workspace/{path}"), content.into());
        Ok(())
    }
    async fn run(&self, _: &str) -> Result<Execution> {
        self.before_effect();
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok(Execution {
            stdout: "42\n".into(),
            stderr: "".into(),
            exit_code: 0,
        })
    }
    async fn remove(&self, path: &str) -> Result<()> {
        self.before_effect();
        self.files
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .retain(|p, _| !p.starts_with(&format!("/workspace/{path}")));
        Ok(())
    }
}
#[async_trait]
impl Workspace for Handle {
    fn identity(&self) -> &str {
        &self.identity
    }
    async fn read_text(&self, path: &str) -> Result<Option<String>> {
        self.before_effect();
        Ok(self
            .files
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .get(path)
            .cloned())
    }
    async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        self.before_effect();
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.files
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .insert(path.into(), content.into());
        Ok(())
    }
}
fn model(steps: Vec<Vec<Value>>) -> Arc<Scripted> {
    let mut model = Scripted::new(steps);
    model.tools = 14;
    Arc::new(model)
}
fn configured(
    model: Arc<Scripted>,
    journal: Arc<Memory>,
    provider: Arc<Provider>,
) -> (Engine, Arc<Calls>) {
    let (mut engine, calls) = setup(model, journal, None);
    engine.workspace_factory = Some(provider);
    (engine, calls)
}
fn read() -> Value {
    call("read_file", json!({"filePath":"/workspace/a"}))
}
fn write() -> Value {
    call(
        "write_file",
        json!({"filePath":"/workspace/a","content":"changed"}),
    )
}
async fn drive(
    engine: &Engine,
    channel: &Channel,
    state: &mut State,
    journal: &Memory,
) -> Result<Phase> {
    engine
        .drive(
            channel,
            state,
            journal,
            &Cancellation::default(),
            deadline(),
        )
        .await
}
#[tokio::test]
async fn files_and_read_permissions_survive_approval_pause_and_engine_replacement() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let provider = Arc::new(Provider::new(journal.clone()));
    let model = model(vec![
        vec![read()],
        vec![call(
            "update_team",
            json!({"slug":"forge","settings":{"name":"Updated"}}),
        )],
        vec![write()],
    ]);
    let (engine, _) = configured(model.clone(), journal.clone(), provider.clone());
    assert_eq!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .unwrap(),
        Phase::Waiting
    );
    assert_eq!(provider.dropped.load(Ordering::SeqCst), 1);
    drop(engine);
    let mut state = journal.load(&channel);
    let request = state.pending_request().unwrap().to_owned();
    let (engine, calls) = configured(model, journal.clone(), provider.clone());
    engine
        .resume(
            &channel,
            &mut state,
            &*journal,
            &request,
            Decision::Approved,
        )
        .await
        .unwrap();
    assert_eq!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .unwrap(),
        Phase::Complete
    );
    assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        provider.files.lock().unwrap().as_ref().unwrap()["/workspace/a"],
        "changed"
    );
    assert_eq!(calls.requests.lock().unwrap().len(), 1);
    let opens = provider.opens.lock().unwrap();
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[0].0, opens[1].0);
    assert!(opens[0].1);
    assert!(!opens[1].1);
    let snapshot = state.snapshot();
    assert_eq!(snapshot["workspace"]["provisioned"], true);
    assert_eq!(snapshot["files"]["stamps"]["/workspace/a"]["bytes"], 7);
    assert!(
        !snapshot
            .to_string()
            .contains("public-fixture-capability-token")
    );
}
#[tokio::test]
async fn lost_provisioning_receipt_prevents_file_effects_until_authoritative_reload() {
    for after in [false, true] {
        let channel = make_channel("user");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        if after {
            journal.fail_after.store(3, Ordering::SeqCst);
        } else {
            journal.fail_before.store(3, Ordering::SeqCst);
        }
        let provider = Arc::new(Provider::new(journal.clone()));
        let (engine, _) = configured(
            model(vec![vec![call(
                "write_file",
                json!({"filePath":"/workspace/new","content":"hello"}),
            )]]),
            journal.clone(),
            provider.clone(),
        );
        assert!(
            drive(&engine, &channel, &mut state, &journal)
                .await
                .is_err()
        );
        assert_eq!(provider.writes.load(Ordering::SeqCst), 0);
        assert_eq!(provider.dropped.load(Ordering::SeqCst), 1);
        let mut recovered = journal.load(&channel);
        assert_eq!(recovered.snapshot()["workspace"]["provisioned"], after);
        assert_eq!(
            drive(&engine, &channel, &mut recovered, &journal)
                .await
                .unwrap(),
            Phase::Complete
        );
        assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
        let opens = provider.opens.lock().unwrap();
        assert_eq!(opens[0].0, opens[1].0);
        assert_eq!(opens[1].1, !after);
    }
}
#[tokio::test]
async fn unacknowledged_file_results_never_repeat_non_idempotent_dispatch() {
    for after in [false, true] {
        let channel = make_channel("user");
        let mut state = initial(&channel);
        let journal = Arc::new(Memory::new(state.clone()));
        if after {
            journal.fail_after.store(5, Ordering::SeqCst);
        } else {
            journal.fail_before.store(5, Ordering::SeqCst);
        }
        let provider = Arc::new(Provider::new(journal.clone()));
        let (engine, _) = configured(
            model(vec![vec![call(
                "write_file",
                json!({"filePath":"/workspace/new","content":"hello"}),
            )]]),
            journal.clone(),
            provider.clone(),
        );
        assert!(
            drive(&engine, &channel, &mut state, &journal)
                .await
                .is_err()
        );
        assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
        let mut recovered = journal.load(&channel);
        let result = drive(&engine, &channel, &mut recovered, &journal).await;
        assert_eq!(result.is_ok(), after);
        assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
        assert_eq!(provider.opens.lock().unwrap().len(), 1);
        assert_eq!(
            recovered.phase(),
            if after {
                Phase::Complete
            } else {
                Phase::Failed
            }
        );
    }
}
#[tokio::test]
async fn interrupted_reads_can_retry_without_repeating_a_completed_file_write() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    journal.fail_before.store(5, Ordering::SeqCst);
    let provider = Arc::new(Provider::new(journal.clone()));
    let (engine, _) = configured(
        model(vec![vec![read()], vec![write()]]),
        journal.clone(),
        provider.clone(),
    );
    assert!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .is_err()
    );
    let mut recovered = journal.load(&channel);
    assert!(
        recovered.snapshot()["files"]["stamps"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        drive(&engine, &channel, &mut recovered, &journal)
            .await
            .unwrap(),
        Phase::Complete
    );
    assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
    assert_eq!(provider.opens.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn workspace_provisioning_is_lazy_and_denied_programs_create_no_resource() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let provider = Arc::new(Provider::new(journal.clone()));
    let (engine, _) = configured(
        model(vec![vec![call(
            "execute_program",
            json!({"language":"javascript","code":"return 1","capabilityManifest":[{"id":"teams.update","version":"1","maximumCalls":1}]}),
        )]]),
        journal.clone(),
        provider.clone(),
    );
    assert_eq!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .unwrap(),
        Phase::Waiting
    );
    assert!(provider.opens.lock().unwrap().is_empty());
    let request = state.pending_request().unwrap().to_owned();
    engine
        .resume(&channel, &mut state, &*journal, &request, Decision::Denied)
        .await
        .unwrap();
    assert_eq!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .unwrap(),
        Phase::Complete
    );
    assert!(provider.opens.lock().unwrap().is_empty());
}
#[tokio::test]
async fn authored_code_and_framework_files_share_one_journaled_workspace() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let provider = Arc::new(Provider::new(journal.clone()));
    let (engine, _) = configured(
        model(vec![
            vec![
                read(),
                call(
                    "run_code",
                    json!({"language":"javascript","code":"console.log(42)"}),
                ),
            ],
            vec![write()],
        ]),
        journal.clone(),
        provider.clone(),
    );
    assert_eq!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .unwrap(),
        Phase::Complete
    );
    assert_eq!(provider.opens.lock().unwrap().len(), 1);
    assert_eq!(provider.runs.load(Ordering::SeqCst), 1);
    assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn unavailable_workspace_and_foreign_read_stamps_fail_without_file_effects() {
    let channel = make_channel("user");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let mut provider = Provider::new(journal.clone());
    provider.unavailable = true;
    let provider = Arc::new(provider);
    let (engine, _) = configured(model(vec![vec![read()]]), journal.clone(), provider.clone());
    assert!(
        drive(&engine, &channel, &mut state, &journal)
            .await
            .is_err()
    );
    assert_eq!(provider.writes.load(Ordering::SeqCst), 0);
    assert_eq!(state.snapshot()["workspace"]["provisioned"], false);
    let mut snapshot = state.snapshot();
    snapshot["files"] = json!({"workspace":"native-workspace:foreign","stamps":{}});
    assert!(State::restore(snapshot, &channel).is_err());
    let mut legacy = initial(&channel).snapshot();
    legacy.as_object_mut().unwrap().remove("workspace");
    legacy.as_object_mut().unwrap().remove("files");
    let legacy = State::restore(legacy, &channel).unwrap();
    assert!(legacy.snapshot()["workspace"].is_null());
}

#[tokio::test]
async fn large_file_writes_keep_exact_private_data_with_a_bounded_display_receipt() {
    let channel = make_channel("owner");
    let mut state = initial(&channel);
    let journal = Arc::new(Memory::new(state.clone()));
    let provider = Arc::new(Provider::new(journal.clone()));
    let content = "λ".repeat(80_000);
    let model = model(vec![vec![call(
        "write_file",
        json!({"filePath":"/workspace/new","content":content}),
    )]]);
    let (engine, _) = configured(model, journal.clone(), provider.clone());
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
    assert_eq!(provider.writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        provider
            .files
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .get("/workspace/new"),
        Some(&content)
    );
    let events = journal.normalized();
    let proposed = events
        .iter()
        .find(|e| e["type"] == "file.patch.proposed")
        .unwrap();
    assert_eq!(proposed["payload"]["input"]["content"], content);
    let displayed = forge_core::agents::presentation::native_event(proposed.clone()).unwrap();
    assert_eq!(displayed["payload"]["input"]["omitted"], true);
    assert!(forge_core::agents::contracts::safe_payload(&displayed["payload"]).is_ok());
}
