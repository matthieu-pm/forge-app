use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use forge_core::agents::runtime::{self, Runtime as AgentRuntime};
use forge_store::{
    agents::{
        self,
        coordinator::{Hosted, Service as Coordinator},
    },
    loops::{ClaimedRun, ExecutionResult, ExecutionState, Executor, Service},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

async fn setup(f: &Fixture) -> (Service, Uuid, Uuid, Value) {
    let s = loop_acceptance::service(f);
    let team = issue_acceptance::team(f, 120).await;
    let issue = issue_acceptance::create(f, team, "Captured source").await;
    let definition = loop_acceptance::create(&s, &f.actor, team, loop_acceptance::fields()).await;
    loop_acceptance::enable(&s, &f.actor, team, definition, 1).await;
    (s, team, definition, issue)
}
async fn queue(f: &Fixture, s: &Service, team: Uuid, definition: Uuid, issue: &Value) -> Uuid {
    let key = Uuid::new_v4().to_string();
    s.command(
        &f.actor,
        &team.to_string(),
        &key,
        json!({"action":"run-now","id":definition,"expectedRevision":2,"entityId":issue["id"]}),
    )
    .await
    .unwrap();
    sqlx::query_scalar("SELECT id FROM loop_runs WHERE loop_id=$1 AND event_key=$2")
        .bind(definition)
        .bind(format!("manual:{key}"))
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
async fn saved(f: &Fixture, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM loop_runs r WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
#[derive(Default)]
struct Probe {
    calls: Mutex<Vec<(Actor, ClaimedRun, Value)>>,
    pause: AtomicBool,
    waiting: AtomicBool,
    failure: Mutex<Option<&'static str>>,
    entered: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
#[async_trait]
impl Executor for Probe {
    async fn execute(
        &self,
        actor: Actor,
        run: ClaimedRun,
        context: Value,
    ) -> Result<ExecutionResult, StoreError> {
        self.calls
            .lock()
            .unwrap()
            .push((actor, run.clone(), context));
        if self.pause.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        if let Some(failure) = *self.failure.lock().unwrap() {
            return Err(StoreError::LoopPolicy(failure));
        }
        let cancelled = run
            .pending_decision
            .as_ref()
            .is_some_and(|p| p["action"] == "cancel-run");
        Ok(ExecutionResult {
            state: if cancelled {
                ExecutionState::Cancelled
            } else if self.waiting.load(Ordering::SeqCst) {
                ExecutionState::WaitingForApproval
            } else {
                ExecutionState::Completed
            },
            result: Some("Result".into()),
            error_code: None,
        })
    }
}

#[tokio::test]
async fn loop_claims_serialize_per_workspace_preserve_new_decisions_and_allow_other_workspaces() {
    for fail_during_execution in [false, true] {
        let f = Fixture::new().await;
        let other = Fixture::new().await;
        let (s, team, definition, issue) = setup(&f).await;
        let first = queue(&f, &s, team, definition, &issue).await;
        let second = queue(&f, &s, team, definition, &issue).await;
        let (other_service, other_team, other_definition, other_issue) = setup(&other).await;
        let other_run = queue(
            &other,
            &other_service,
            other_team,
            other_definition,
            &other_issue,
        )
        .await;
        let probe = Probe::default();
        probe.pause.store(true, Ordering::SeqCst);
        probe.waiting.store(true, Ordering::SeqCst);
        if fail_during_execution {
            *probe.failure.lock().unwrap() = Some("fixture execution failed");
        }
        let execute = s.execute_next_with(&probe, Some(&f.actor.workspace_id));
        let race = async {
            probe.entered.notified().await;
            assert_eq!(
                s.execute_next_with(&Probe::default(), Some(&f.actor.workspace_id))
                    .await
                    .unwrap(),
                None
            );
            assert_eq!(
                other_service
                    .execute_next_with(&Probe::default(), Some(&other.actor.workspace_id))
                    .await
                    .unwrap(),
                Some(other_run)
            );
            assert_eq!(saved(&f, second).await["state"], "queued");
            sqlx::query("UPDATE loop_runs SET pending_decision=$2 WHERE id=$1")
                .bind(first)
                .bind(json!({"action":"cancel-run","requestedById":f.actor.user_id}))
                .execute(&f.pool)
                .await
                .unwrap();
            probe.resume.notify_one();
        };
        let (result, ()) = tokio::join!(execute, race);
        assert_eq!(result.unwrap(), Some(first));
        let waiting = saved(&f, first).await;
        assert_eq!(waiting["state"], "waiting-for-approval");
        assert_eq!(waiting["pending_decision"]["action"], "cancel-run");
        *probe.failure.lock().unwrap() = None;
        assert_eq!(
            s.execute_next_with(&probe, Some(&f.actor.workspace_id))
                .await
                .unwrap(),
            Some(first)
        );
        assert_eq!(saved(&f, first).await["state"], "cancelled");
        let calls = probe.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].1.started_at, calls[1].1.started_at);
        assert!(calls[1].0.loop_scope.as_ref().unwrap().cancelling);
        assert_eq!(
            calls[1].0.scopes,
            Some(vec![ApiScope::AgentsRead, ApiScope::AgentsWrite])
        );
    }
}

#[tokio::test]
async fn uncertain_dispatch_is_quarantined_and_never_retried_after_the_quarantine_window() {
    let f = Fixture::new().await;
    let (mut s, team, definition, issue) = setup(&f).await;
    let first = queue(&f, &s, team, definition, &issue).await;
    let second = queue(&f, &s, team, definition, &issue).await;
    let probe = Probe::default();
    *probe.failure.lock().unwrap() = Some("UNCERTAIN_DISPATCH");
    s.options.enabled = false;
    assert_eq!(
        s.execute_next_with(&probe, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        None
    );
    s.options.enabled = true;
    assert_eq!(
        s.execute_next_with(&probe, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        Some(first)
    );
    assert_eq!(saved(&f, first).await["state"], "uncertain");
    assert_eq!(
        saved(&f, first).await["error_code"],
        "DISPATCH_REQUIRES_RECONCILIATION"
    );
    assert_eq!(
        s.execute_next_with(&probe, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        None
    );
    sqlx::query("UPDATE loop_runs SET started_at=clock_timestamp()-interval '6 minutes',lease_at=NULL WHERE id=$1").bind(first).execute(&f.pool).await.unwrap();
    *probe.failure.lock().unwrap() = None;
    assert_eq!(
        s.execute_next_with(&probe, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        Some(second)
    );
    assert_eq!(saved(&f, first).await["state"], "uncertain");
    assert_eq!(probe.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn missing_sources_and_expired_original_deadlines_stop_before_executor_dispatch() {
    for expired in [false, true] {
        let f = Fixture::new().await;
        let (s, team, definition, issue) = setup(&f).await;
        let run = queue(&f, &s, team, definition, &issue).await;
        if expired {
            sqlx::query("UPDATE loop_runs SET state='waiting-for-approval',started_at=clock_timestamp()-interval '5 minutes',pending_decision=$2 WHERE id=$1").bind(run).bind(json!({"action":"approve"})).execute(&f.pool).await.unwrap();
        } else {
            sqlx::query("UPDATE issues SET deleted_at=clock_timestamp() WHERE id::text=$1")
                .bind(issue["id"].as_str().unwrap())
                .execute(&f.pool)
                .await
                .unwrap();
        }
        let before = saved(&f, run).await;
        let probe = Probe::default();
        assert_eq!(
            s.execute_next_with(&probe, Some(&f.actor.workspace_id))
                .await
                .unwrap(),
            Some(run)
        );
        assert!(probe.calls.lock().unwrap().is_empty());
        let after = saved(&f, run).await;
        assert_eq!(
            after["state"],
            if expired { "uncertain" } else { "blocked" }
        );
        assert_eq!(
            after["error_code"],
            if expired {
                "DISPATCH_REQUIRES_RECONCILIATION"
            } else {
                "ACCESS_REVOKED"
            }
        );
        if expired {
            assert_eq!(before["started_at"], after["started_at"]);
        }
    }
}

#[tokio::test]
async fn reviewer_membership_revocation_restores_waiting_without_spending_the_decision() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let reviewer = enter_workspace(&f, &visitor).await;
    let (s, team, definition, issue) = setup(&f).await;
    let run = queue(&f, &s, team, definition, &issue).await;
    sqlx::query("UPDATE loop_runs SET state='waiting-for-approval',started_at=clock_timestamp(),pending_decision=$2 WHERE id=$1").bind(run).bind(json!({"action":"approve","approvalId":Uuid::new_v4(),"requestedById":reviewer.user_id})).execute(&f.pool).await.unwrap();
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&reviewer.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let before = saved(&f, run).await;
    let probe = Probe::default();
    s.execute_next_with(&probe, Some(&f.actor.workspace_id))
        .await
        .unwrap();
    let after = saved(&f, run).await;
    assert_eq!(after["state"], "waiting-for-approval");
    assert_eq!(after["error_code"], "REVIEWER_ACCESS_REVOKED");
    assert!(after["pending_decision"].is_null());
    assert!(after["finished_at"].is_null());
    assert_eq!(before["started_at"], after["started_at"]);
    assert!(probe.calls.lock().unwrap().is_empty());
}

#[derive(Default)]
struct RuntimeFixture {
    start: Mutex<Vec<Value>>,
    resume: Mutex<Vec<Value>>,
    messages: Mutex<Vec<String>>,
    contexts: Mutex<Vec<runtime::Context>>,
    responses: Mutex<Vec<Value>>,
    starts: AtomicUsize,
    resumes: AtomicUsize,
    cancels: AtomicUsize,
}
fn scripted(context: runtime::Context, steps: Vec<Value>) -> runtime::Events {
    Box::pin(futures_util::stream::try_unfold(
        (context, steps.into_iter()),
        |(context, mut steps)| async move {
            loop {
                match steps.next() {
                    None => return Ok(None),
                    Some(v) if v["checkpoint"] == true => {
                        context
                            .checkpoint
                            .save(format!("loop-cursor:{}", context.run_id))
                            .await?
                    }
                    Some(v) => return Ok(Some((v, (context, steps)))),
                }
            }
        },
    ))
}
#[async_trait]
impl AgentRuntime for RuntimeFixture {
    fn kind(&self) -> &'static str {
        "eve"
    }
    fn start(&self, c: runtime::Context, message: String, _: Vec<Value>) -> runtime::Events {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.messages.lock().unwrap().push(message);
        self.contexts.lock().unwrap().push(c.clone());
        scripted(c, self.start.lock().unwrap().clone())
    }
    fn resume(&self, c: runtime::Context, responses: Vec<Value>) -> runtime::Events {
        self.resumes.fetch_add(1, Ordering::SeqCst);
        self.responses.lock().unwrap().extend(responses);
        self.contexts.lock().unwrap().push(c.clone());
        scripted(c, self.resume.lock().unwrap().clone())
    }
    fn reconnect(&self, c: runtime::Context) -> runtime::Events {
        scripted(c, vec![])
    }
    async fn cancel(
        &self,
        _: &str,
        _: Option<&str>,
        _: Option<&runtime::Context>,
    ) -> Result<(), runtime::Error> {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
fn event(id: &str, kind: &str, payload: Value) -> Value {
    json!({"sourceEventId":id,"source":"eve","type":kind,"payload":payload})
}
async fn cloud(f: &Fixture) -> (Service, Uuid, Uuid, Value, Arc<RuntimeFixture>) {
    let (mut loops, team, definition, issue) = setup(f).await;
    let provider = Arc::new(model_discovery::Provider::default());
    let vault =
        Arc::new(forge_identity::model_vault::Vault::new(&STANDARD.encode([7; 32])).unwrap());
    let models = agents::model_connections::Service::new(f.database.clone(), provider, vault);
    models.create(&f.actor,json!({"provider":"openai","scope":"workspace","displayName":"Loop workspace API","apiKey":"fixture-key"})).await.unwrap();
    let runtime = Arc::new(RuntimeFixture::default());
    let mut hosted = Hosted::new(Arc::new(models), vec![runtime.clone()]);
    hosted.features = json!({"agent_ui":true,"agent_eve_runtime":true,"agent_auto_openai":true,"agent_provider_openai":true});
    let mut coordinator = Coordinator::new(f.database.clone());
    coordinator.controls["userMonthlyBudgetMicros"] = json!(0);
    coordinator.hosted = Some(Arc::new(hosted));
    loops.agents = Some(Arc::new(coordinator));
    (loops, team, definition, issue, runtime)
}
fn waiting_script() -> Vec<Value> {
    vec![
        json!({"checkpoint":true}),
        event(
            "approval",
            "approval.requested",
            json!({"capabilityId":"teams.update","risk":"reversible-write","summary":"Review this write","details":{"runtimeRequestId":"loop-input"},"input":{"name":"Updated"}}),
        ),
    ]
}

#[tokio::test]
async fn cloud_loop_uses_reserved_identity_captured_instructions_current_context_and_shared_thread_guards()
 {
    let f = Fixture::new().await;
    let (s, team, definition, issue, runtime) = cloud(&f).await;
    let run = queue(&f, &s, team, definition, &issue).await;
    let captured = saved(&f, run).await;
    let mut changed = loop_acceptance::fields();
    changed["instructions"] = json!("New instructions after capture");
    s.command(
        &f.actor,
        &team.to_string(),
        &Uuid::new_v4().to_string(),
        json!({"action":"save","id":definition,"expectedRevision":2,"fields":changed}),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE issues SET title='Current source title' WHERE id::text=$1")
        .bind(issue["id"].as_str().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    *runtime.start.lock().unwrap() = vec![
        event(
            "delta",
            "assistant.delta",
            json!({"messageId":"m","delta":"Draft"}),
        ),
        event(
            "message",
            "assistant.message",
            json!({"messageId":"m","text":"Completed investigation"}),
        ),
    ];
    assert_eq!(
        s.execute_next(Some(&f.actor.workspace_id)).await.unwrap(),
        Some(run)
    );
    let finished = saved(&f, run).await;
    assert_eq!(finished["state"], "completed");
    assert_eq!(finished["result"], "Completed investigation");
    let agent_run: Uuid = captured["agent_run_id"].as_str().unwrap().parse().unwrap();
    let thread: Uuid = captured["thread_id"].as_str().unwrap().parse().unwrap();
    let agent = agents::runs::get(&f.database, &f.actor.workspace_id, agent_run)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(agent.requested_selection["loopRunId"], run.to_string());
    assert_eq!(
        agent.initiated_by_user_id,
        forge_core::loops::principal_id(&definition.to_string())
    );
    {
        let contexts = runtime.contexts.lock().unwrap();
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].run_id, agent_run.to_string());
        assert_eq!(contexts[0].thread_id, thread.to_string());
        let started: DateTime<Utc> =
            serde_json::from_value(finished["started_at"].clone()).unwrap();
        assert_eq!(
            contexts[0].deadline_ms,
            started.timestamp_millis() + 240_000
        );
    }
    {
        let messages = runtime.messages.lock().unwrap();
        assert!(messages[0].contains("Inspect this issue."));
        assert!(!messages[0].contains("New instructions after capture"));
        assert!(messages[0].contains("Current source title"));
    }
    let coordinator = s.agents.as_ref().unwrap();
    assert!(coordinator.thread_events(&f.actor, thread).await.is_err());
    assert!(coordinator.list_threads(&f.actor).await.unwrap().is_empty());
    assert_eq!(
        s.execute_next(Some(&f.actor.workspace_id)).await.unwrap(),
        None
    );
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cloud_approval_resumes_same_run_attributes_the_human_and_preserves_original_deadline() {
    let f = Fixture::new().await;
    let (s, team, definition, issue, runtime) = cloud(&f).await;
    *runtime.start.lock().unwrap() = waiting_script();
    *runtime.resume.lock().unwrap() = vec![event(
        "resumed",
        "assistant.delta",
        json!({"messageId":"m","text":"Reviewed result"}),
    )];
    let run = queue(&f, &s, team, definition, &issue).await;
    s.execute_next(Some(&f.actor.workspace_id)).await.unwrap();
    let waiting = saved(&f, run).await;
    assert_eq!(waiting["state"], "waiting-for-approval");
    let agent_run: Uuid = waiting["agent_run_id"].as_str().unwrap().parse().unwrap();
    let (approval, hash): (Uuid, String) =
        sqlx::query_as("SELECT id,input_hash FROM agent_approvals WHERE run_id=$1")
            .bind(agent_run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(
        s.agents
            .as_ref()
            .unwrap()
            .resolve_approval(
                &f.actor,
                approval,
                agents::approval_service::Decision::Approved,
                None
            )
            .await
            .is_err()
    );
    s.command(&f.actor,&team.to_string(),&Uuid::new_v4().to_string(),json!({"action":"approve","id":definition,"expectedRevision":2,"runId":run,"approvalId":approval,"inputHash":hash})).await.unwrap();
    s.execute_next(Some(&f.actor.workspace_id)).await.unwrap();
    let finished = saved(&f, run).await;
    assert_eq!(finished["state"], "completed");
    assert_eq!(finished["result"], "Reviewed result");
    assert_eq!(finished["started_at"], waiting["started_at"]);
    let reviewer: Option<String> =
        sqlx::query_scalar("SELECT resolved_by_user_id FROM agent_approvals WHERE id=$1")
            .bind(approval)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(reviewer, Some(f.actor.user_id.clone()));
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.resumes.load(Ordering::SeqCst), 1);
    assert_eq!(
        *runtime.responses.lock().unwrap(),
        vec![json!({"requestId":"loop-input","optionId":"approve"})]
    );
    let contexts = runtime.contexts.lock().unwrap();
    assert_eq!(contexts.len(), 2);
    assert_eq!(contexts[0].run_id, contexts[1].run_id);
    assert_eq!(contexts[0].deadline_ms, contexts[1].deadline_ms);
}

#[tokio::test]
async fn disabling_a_waiting_loop_cancels_the_reserved_agent_even_after_its_original_deadline() {
    let f = Fixture::new().await;
    let (s, team, definition, issue, runtime) = cloud(&f).await;
    *runtime.start.lock().unwrap() = waiting_script();
    let run = queue(&f, &s, team, definition, &issue).await;
    s.execute_next(Some(&f.actor.workspace_id)).await.unwrap();
    s.command(
        &f.actor,
        &team.to_string(),
        &Uuid::new_v4().to_string(),
        json!({"action":"disable","id":definition,"expectedRevision":2}),
    )
    .await
    .unwrap();
    sqlx::query(
        "UPDATE loop_runs SET started_at=clock_timestamp()-interval '5 minutes' WHERE id=$1",
    )
    .bind(run)
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        s.execute_next(Some(&f.actor.workspace_id)).await.unwrap(),
        Some(run)
    );
    let cancelled = saved(&f, run).await;
    assert_eq!(cancelled["state"], "cancelled");
    assert!(cancelled["pending_decision"].is_null());
    let state: String = sqlx::query_scalar("SELECT state FROM agent_runs WHERE id::text=$1")
        .bind(cancelled["agent_run_id"].as_str().unwrap())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(state, "cancelled");
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.cancels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cloud_worker_does_not_redispatch_an_existing_reserved_agent_run() {
    let f = Fixture::new().await;
    let (s, team, definition, _, runtime) = cloud(&f).await;
    let c = loop_authority_acceptance::occurrence(&f, definition, json!({"kind":"manual"})).await;
    sqlx::query("UPDATE loop_runs SET state='queued' WHERE id=$1")
        .bind(c.run)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        s.execute_next(Some(&f.actor.workspace_id)).await.unwrap(),
        Some(c.run)
    );
    assert_eq!(saved(&f, c.run).await["state"], "uncertain");
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        s.execute_next(Some(&f.actor.workspace_id)).await.unwrap(),
        None
    );
    assert!(
        s.read(&f.actor, &team.to_string()).await.unwrap()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == c.run.to_string())
    );
}

#[tokio::test]
async fn shared_loop_execution_retains_the_workspace_budget_limit() {
    let f = Fixture::new().await;
    let (mut s, team, definition, issue, runtime) = cloud(&f).await;
    let mut coordinator = (**s.agents.as_ref().unwrap()).clone();
    coordinator.controls["workspaceMonthlyBudgetMicros"] = json!(0);
    s.agents = Some(Arc::new(coordinator));
    let run = queue(&f, &s, team, definition, &issue).await;
    s.execute_next(Some(&f.actor.workspace_id)).await.unwrap();
    assert_eq!(saved(&f, run).await["state"], "failed");
    assert_eq!(runtime.starts.load(Ordering::SeqCst), 0);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE t.workspace_id=$1").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 0);
}
