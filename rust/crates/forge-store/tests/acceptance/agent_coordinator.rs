use super::*;
use forge_store::agents::coordinator::{CODEX_LOCAL_CONNECTION_ID, Service};
use std::sync::{Arc, atomic::Ordering};

fn service(f: &Fixture) -> Service {
    let mut service = Service::new(f.database.clone());
    service.now = Arc::new(at);
    service
}
fn input(thread: Uuid) -> Value {
    json!({"threadId":thread,"runtimeId":"codex","message":"Summarize this workspace","model":{"selectionId":"local:codex:gpt-codex","connectionId":CODEX_LOCAL_CONNECTION_ID,"executionKind":"external-agent","provider":"openai","modelId":"gpt-codex"},"reasoningEffort":"high"})
}
fn incoming(id: &str, kind: &str, payload: Value) -> Value {
    json!({"sourceEventId":id,"source":"codex","type":kind,"occurredAt":"2026-11-01T12:00:01.000Z","payload":payload})
}
fn pick(value: Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| ((*key).into(), value[*key].clone()))
            .collect(),
    )
}
async fn own_run(f: &Fixture, service: &Service) -> (Thread, Run) {
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let prepared = service
        .prepare_local(&f.actor, input(thread.id))
        .await
        .unwrap();
    (thread, prepared.run)
}
async fn join(f: &Fixture, other: &Fixture) -> Actor {
    sqlx::query("INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')")
        .bind(Uuid::new_v4().to_string())
        .bind(&other.actor.user_id)
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE session SET active_organization_id=$1 WHERE token=$2")
        .bind(&f.actor.workspace_id)
        .bind(&other.token)
        .execute(&f.pool)
        .await
        .unwrap();
    Actor {
        workspace_id: f.actor.workspace_id.clone(),
        ..other.actor.clone()
    }
}
#[tokio::test]
async fn coordinator_local_flow_matches_source_and_keeps_virtual_connection_private() {
    let data: Value =
        serde_json::from_str(include_str!("../../../../reference-fixtures.json")).unwrap();
    for case in data["coordinator"]["local"].as_array().unwrap() {
        let f = Fixture::new().await;
        let service = service(&f);
        let spec = &case["spec"];
        let thread = service
            .create_thread(
                &f.actor,
                json!({"runtimeKind":spec["runtimeKind"].as_str().unwrap_or("eve")}),
            )
            .await
            .unwrap();
        if let Some(cursor) = spec["cursor"].as_str() {
            threads::update(
                &f.database,
                &f.actor.workspace_id,
                thread.id,
                &ThreadPatch {
                    runtime_session_id: Some(Some(cursor.into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let mut input = case["input"].clone();
        input["threadId"] = json!(thread.id);
        let prepared = service.prepare_local(&f.actor, input).await.unwrap();
        let event_keys = ["sequence", "occurredAt", "source", "type", "payload"];
        let thread_keys = ["title", "status", "runtimeKind", "runtimeSessionId"];
        assert_eq!(
            json!(
                prepared
                    .initial_events
                    .iter()
                    .map(|event| pick(json!(event), &event_keys))
                    .collect::<Vec<_>>()
            ),
            case["initialEvents"],
            "{spec}"
        );
        assert_eq!(
            pick(json!(prepared.thread), &thread_keys),
            case["initialThread"]
        );
        assert_ne!(
            prepared.run.resolved_connection_id.unwrap().to_string(),
            CODEX_LOCAL_CONNECTION_ID
        );
        service
            .checkpoint_local(
                &f.actor,
                prepared.run.id,
                json!({"runtimeSessionId":"codex-thread","runtimeRunId":"codex-turn"}),
            )
            .await
            .unwrap();
        let events = service
            .ingest_local(&f.actor, prepared.run.id, case["events"].clone())
            .await
            .unwrap();
        assert_eq!(
            json!(
                events
                    .iter()
                    .map(|event| pick(json!(event), &event_keys))
                    .collect::<Vec<_>>()
            ),
            case["ingested"]
        );
        let run = runs::get(&f.database, &f.actor.workspace_id, prepared.run.id)
            .await
            .unwrap()
            .unwrap();
        let keys: Vec<_> = case["run"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(pick(json!(run), &keys), case["run"], "{spec}");
        assert_eq!(
            pick(
                json!(
                    threads::get(&f.database, &f.actor.workspace_id, thread.id)
                        .await
                        .unwrap()
                        .unwrap()
                ),
                &thread_keys
            ),
            case["thread"]
        );
        assert_eq!(
            pick(
                json!(service.get_preference(&f.actor, thread.id).await.unwrap()),
                &[
                    "mode",
                    "selectedConnectionId",
                    "selectedModelId",
                    "selectedEffort"
                ]
            ),
            case["preference"]
        );
        // Runtime session and turn IDs are globally unique in the schema.
        runs::update(
            &f.database,
            prepared.run.id,
            &RunPatch {
                runtime_run_id: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        threads::update(
            &f.database,
            &f.actor.workspace_id,
            thread.id,
            &ThreadPatch {
                runtime_session_id: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
}
#[tokio::test]
async fn coordinator_rechecks_membership_scopes_ownership_and_shared_loop_separation() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let stranger = join(&f, &other).await;
    let service = service(&f);
    let (thread, run) = own_run(&f, &service).await;
    assert!(service.list_threads(&stranger).await.unwrap().is_empty());
    assert!(service.thread_events(&stranger, thread.id).await.is_err());
    assert!(service.run_events(&stranger, run.id, 0).await.is_err());
    assert!(
        service
            .mutate_thread(&stranger, thread.id, json!({"action":"archive"}))
            .await
            .is_err()
    );
    let mut scoped = f.actor.clone();
    scoped.scopes = Some(vec![ApiScope::AgentsRead]);
    assert!(service.create_thread(&scoped, json!({})).await.is_err());
    assert_eq!(
        service
            .mutate_thread(
                &f.actor,
                thread.id,
                json!({"action":"rename","title":" Renamed "})
            )
            .await
            .unwrap()
            .title,
        "Renamed"
    );
    service
        .mutate_thread(&f.actor, thread.id, json!({"action":"archive"}))
        .await
        .unwrap();
    assert!(matches!(
        service.prepare_local(&f.actor, input(thread.id)).await,
        Err(StoreError::AgentCoordinator {
            code: "THREAD_ARCHIVED",
            ..
        })
    ));
    assert_eq!(
        service.run_events(&f.actor, run.id, 1).await.unwrap().len(),
        2
    );
    service
        .mutate_thread(&f.actor, thread.id, json!({"action":"reopen"}))
        .await
        .unwrap();
    let team = forge_store::teams::create(&f.database, &f.actor, &team_input(0))
        .await
        .unwrap();
    let loop_id = Uuid::new_v4();
    sqlx::query("INSERT INTO team_loops(id,workspace_id,team_id,fields) VALUES($1,$2,$3,'{}')")
        .bind(loop_id)
        .bind(&f.actor.workspace_id)
        .bind(team.id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,thread_id,agent_run_id) VALUES($1,$2,$3,1,'coordinator-test',$4,'{}','{}',$5,'completed',$6,$7)").bind(Uuid::new_v4()).bind(&f.actor.workspace_id).bind(loop_id).bind("a".repeat(64)).bind(&f.actor.user_id).bind(thread.id).bind(run.id).execute(&f.pool).await.unwrap();
    assert!(service.list_threads(&f.actor).await.unwrap().is_empty());
    assert!(service.thread_events(&f.actor, thread.id).await.is_err());
    assert!(service.cancel_local(&f.actor, run.id).await.is_err());
    sqlx::query("DELETE FROM member WHERE user_id=$1 AND organization_id=$2")
        .bind(&other.actor.user_id)
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(service.list_threads(&stranger).await.is_err());
}
#[tokio::test]
async fn coordinator_preferences_support_auto_connection_and_do_not_cross_personal_boundaries() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let stranger = join(&f, &other).await;
    let service = service(&f);
    let first = service.create_thread(&f.actor, json!({})).await.unwrap();
    let second = service.create_thread(&stranger, json!({})).await.unwrap();
    assert_eq!(
        service
            .get_preference(&f.actor, first.id)
            .await
            .unwrap()
            .mode,
        SelectionMode::Auto
    );
    let manual = json!({"mode":"manual","selectedConnectionId":CODEX_LOCAL_CONNECTION_ID,"selectedModelId":"gpt-codex","selectedEffort":"high"});
    service
        .set_preference(&f.actor, first.id, manual.clone())
        .await
        .unwrap();
    service
        .set_preference(&stranger, second.id, manual)
        .await
        .unwrap();
    let first_id = preferences::get(&f.database, first.id)
        .await
        .unwrap()
        .unwrap()
        .selected_connection_id
        .unwrap();
    let second_id = preferences::get(&f.database, second.id)
        .await
        .unwrap()
        .unwrap()
        .selected_connection_id
        .unwrap();
    assert_ne!(first_id, second_id);
    let pref = json!({"mode":"auto","selectedConnectionId":first_id,"selectedModelId":null,"selectedEffort":null});
    assert!(
        service
            .set_preference(&stranger, second.id, pref.clone())
            .await
            .is_err()
    );
    service
        .set_preference(&f.actor, first.id, pref)
        .await
        .unwrap();
    let pref = service.get_preference(&f.actor, first.id).await.unwrap();
    assert_eq!(pref.mode, SelectionMode::Auto);
    assert_eq!(
        pref.selected_connection_id.unwrap().to_string(),
        CODEX_LOCAL_CONNECTION_ID
    );
    let private:bool=sqlx::query_scalar("SELECT scope='personal' AND credential_owner='provider-process' AND secret_reference IS NULL FROM model_connections WHERE id=$1").bind(first_id).fetch_one(&f.pool).await.unwrap();
    assert!(private);
}
#[tokio::test]
async fn coordinator_concurrent_usage_replays_are_counted_once_and_terminal_runs_stay_terminal() {
    let f = Fixture::new().await;
    let service = service(&f);
    let (_, run) = own_run(&f, &service).await;
    let batch = json!([incoming(
        "usage-one",
        "run.usage",
        json!({"inputTokens":10,"outputTokens":4,"costMicros":7})
    )]);
    let other = service.clone();
    let actor = f.actor.clone();
    let duplicate = batch.clone();
    let task = tokio::spawn(async move { other.ingest_local(&actor, run.id, duplicate).await });
    let first = service
        .ingest_local(&f.actor, run.id, batch.clone())
        .await
        .unwrap();
    let second = task.await.unwrap().unwrap();
    assert_eq!(first, second);
    let stored = runs::get(&f.database, &f.actor.workspace_id, run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            stored.input_tokens,
            stored.output_tokens,
            stored.cost_micros
        ),
        (10, 4, 7)
    );
    assert!(
        service
            .ingest_local(
                &f.actor,
                run.id,
                json!([
                    incoming(
                        "good-before-bad",
                        "assistant.message",
                        json!({"content":"Rollback"})
                    ),
                    incoming(
                        "bad-usage",
                        "run.usage",
                        json!({"inputTokens":2147483648_u64})
                    )
                ])
            )
            .await
            .is_err()
    );
    assert_eq!(
        service.run_events(&f.actor, run.id, 0).await.unwrap().len(),
        4
    );
    assert!(
        service
            .ingest_local(
                &f.actor,
                run.id,
                json!([incoming(
                    "usage-one",
                    "run.usage",
                    json!({"access_token":"private"})
                )])
            )
            .await
            .is_err()
    );
    let end = json!([incoming("done", "run.completed", json!({}))]);
    service
        .ingest_local(&f.actor, run.id, end.clone())
        .await
        .unwrap();
    service.ingest_local(&f.actor, run.id, end).await.unwrap();
    service.ingest_local(&f.actor, run.id, batch).await.unwrap();
    assert!(
        service
            .ingest_local(
                &f.actor,
                run.id,
                json!([incoming("late", "run.failed", json!({}))])
            )
            .await
            .is_err()
    );
    assert!(
        service
            .checkpoint_local(
                &f.actor,
                run.id,
                json!({"runtimeSessionId":"late","runtimeRunId":"late"})
            )
            .await
            .is_err()
    );
    assert!(service.cancel_local(&f.actor, run.id).await.is_err());
    assert_eq!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::Completed
    );
}
#[tokio::test]
async fn coordinator_local_approvals_remain_canonical_and_replays_cannot_reopen_them() {
    let f = Fixture::new().await;
    let service = service(&f);
    let (_, run) = own_run(&f, &service).await;
    let id = Uuid::new_v4();
    let request = json!([incoming(
        "local-approval",
        "approval.requested",
        json!({"approvalId":id,"capabilityId":"teams.update","risk":"reversible-write","summary":"Update team","input":{"name":"New"},"details":{"runtimeRequestId":"request"},"expiresAt":iso_time(at()+Duration::minutes(5))})
    )]);
    let first = service
        .ingest_local(&f.actor, run.id, request.clone())
        .await
        .unwrap();
    assert_eq!(first[0].source, "forge");
    let acknowledgement = json!([incoming(
        "local-resolved",
        "approval.resolved",
        json!({"approvalId":id,"decision":"approved"})
    )]);
    assert!(
        service
            .ingest_local(&f.actor, run.id, acknowledgement.clone())
            .await
            .is_err()
    );
    approval_service::Service::new(f.database.clone())
        .with_clock(Arc::new(at))
        .resolve(&f.actor, id, approval_service::Decision::Approved)
        .await
        .unwrap();
    assert_eq!(
        service
            .ingest_local(&f.actor, run.id, request)
            .await
            .unwrap(),
        first
    );
    assert!(
        service
            .ingest_local(&f.actor, run.id, acknowledgement)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
    let cancelled = service.cancel_local(&f.actor, run.id).await.unwrap();
    assert_eq!(
        service.cancel_local(&f.actor, run.id).await.unwrap(),
        cancelled
    );
}
fn iso_time(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
#[tokio::test]
async fn coordinator_run_creation_rolls_back_connections_preferences_cursor_and_events_together() {
    let f = Fixture::new().await;
    let service = service(&f);
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let function = format!("reject_coordinator_{suffix}");
    sqlx::raw_sql(&format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture rejection'; END; $$; CREATE TRIGGER {function} BEFORE INSERT ON agent_events FOR EACH ROW WHEN (NEW.thread_id='{}'::uuid AND NEW.type='run.started') EXECUTE FUNCTION {function}();",thread.id)).execute(&f.pool).await.unwrap();
    assert!(
        service
            .prepare_local(&f.actor, input(thread.id))
            .await
            .is_err()
    );
    assert!(
        preferences::get(&f.database, thread.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        service
            .thread_events(&f.actor, thread.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        threads::get(&f.database, &f.actor.workspace_id, thread.id)
            .await
            .unwrap()
            .unwrap()
            .runtime_kind,
        Runtime::Eve
    );
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM model_connections WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {function} ON agent_events; DROP FUNCTION {function}();"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    service
        .prepare_local(&f.actor, input(thread.id))
        .await
        .unwrap();
}
#[tokio::test]
async fn coordinator_attachments_are_private_and_revocation_during_io_prevents_run_creation() {
    let f = Fixture::new().await;
    let blobs = Arc::new(blobs::Memory::default());
    let mut files = files::Service::new(f.database.clone(), blobs.clone());
    files.now = Arc::new(at);
    let files = Arc::new(files);
    let mut service = service(&f);
    service.attachments = Some(files.clone());
    let attachment = files
        .upload_attachment(
            &f.actor,
            json!({"name":"fixture.txt","contentType":"text/plain","contentBase64":"aGVsbG8="}),
        )
        .await
        .unwrap();
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let mut input = input(thread.id);
    input["attachmentIds"] = json!([attachment["id"]]);
    let prepared = service
        .prepare_local(&f.actor, input.clone())
        .await
        .unwrap();
    assert_eq!(prepared.attachments[0]["contentBase64"], "aGVsbG8=");
    assert!(
        prepared.initial_events[0].payload["attachments"][0]
            .get("contentBase64")
            .is_none()
    );
    service
        .cancel_local(&f.actor, prepared.run.id)
        .await
        .unwrap();
    blobs.pause_get.store(true, Ordering::SeqCst);
    let actor = f.actor.clone();
    let other = service.clone();
    let task = tokio::spawn(async move { other.prepare_local(&actor, input).await });
    blobs.entered.notified().await;
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    blobs.resume.notify_one();
    assert!(task.await.unwrap().is_err());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE thread_id=$1")
        .bind(thread.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn coordinator_admission_serializes_thread_ownership_and_enforces_live_policy_and_budget() {
    let f = Fixture::new().await;
    let mut service = service(&f);
    let thread = service.create_thread(&f.actor, json!({})).await.unwrap();
    let other = service.clone();
    let actor = f.actor.clone();
    let task = tokio::spawn(async move { other.prepare_local(&actor, input(thread.id)).await });
    let result = service.prepare_local(&f.actor, input(thread.id)).await;
    let other = task.await.unwrap();
    assert_ne!(result.is_ok(), other.is_ok());
    let run = result.or(other).unwrap().run;
    service.cancel_local(&f.actor, run.id).await.unwrap();
    sqlx::query("UPDATE agent_runs SET cost_micros=20,created_at=$2 WHERE id=$1")
        .bind(run.id)
        .bind(at())
        .execute(&f.pool)
        .await
        .unwrap();
    service.controls["userMonthlyBudgetMicros"] = json!(20);
    assert!(matches!(
        service.prepare_local(&f.actor, input(thread.id)).await,
        Err(StoreError::AgentCoordinator {
            code: "BUDGET_EXCEEDED",
            ..
        })
    ));
    service.controls["userMonthlyBudgetMicros"] = Value::Null;
    sqlx::query("UPDATE member SET role='guest' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,block_guest_agent_access) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET block_guest_agent_access=true").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        service.prepare_local(&f.actor, input(thread.id)).await,
        Err(StoreError::Forbidden)
    ));
    assert!(service.create_thread(&f.actor, json!({})).await.is_err());
}
#[tokio::test]
async fn coordinator_checkpoint_failure_cannot_publish_only_the_runtime_run_id() {
    let f = Fixture::new().await;
    let service = service(&f);
    let (thread, run) = own_run(&f, &service).await;
    let other = service
        .create_thread(&f.actor, json!({"runtimeKind":"codex"}))
        .await
        .unwrap();
    let cursor = Uuid::new_v4().to_string();
    threads::update(
        &f.database,
        &f.actor.workspace_id,
        other.id,
        &ThreadPatch {
            runtime_session_id: Some(Some(cursor.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        service
            .checkpoint_local(
                &f.actor,
                run.id,
                json!({"runtimeSessionId":cursor,"runtimeRunId":"new-run"})
            )
            .await
            .is_err()
    );
    assert!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .runtime_run_id
            .is_none()
    );
    assert!(
        threads::get(&f.database, &f.actor.workspace_id, thread.id)
            .await
            .unwrap()
            .unwrap()
            .runtime_session_id
            .is_none()
    );
}
