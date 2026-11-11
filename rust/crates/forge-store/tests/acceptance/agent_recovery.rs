use super::*;
use chrono::{Duration, Utc};
use forge_store::agents::*;
use serde_json::{Value, json};

#[tokio::test]
async fn agent_mutations_prepare_before_changes_and_archive_released_reservations() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Agent recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let mut input = CreateThread {
        id: Uuid::new_v4(),
        workspace_id: actor.workspace_id.clone(),
        created_by_user_id: actor.user_id.clone(),
        title: "Private chat".into(),
        status: ThreadStatus::Active,
        runtime_kind: Runtime::Eve,
        runtime_session_id: None,
        created_at: Utc::now(),
    };
    let thread = threads::create(&f.database, &input).await.unwrap();
    let run = runs::create(
        &f.database,
        &CreateRun {
            id: Uuid::new_v4(),
            thread_id: thread.id,
            initiated_by_user_id: actor.user_id.clone(),
            state: RunState::Created,
            execution_kind: Execution::ForgeNative,
            requested_selection: json!({"mode":"auto"}),
            resolved_connection_id: None,
            resolved_model_id: None,
            reasoning_effort: None,
            routing_policy_version: None,
            routing_reason: None,
            runtime_run_id: None,
            input_tokens: 0,
            output_tokens: 0,
            cached_input_tokens: 0,
            cost_micros: 0,
            started_at: None,
            completed_at: None,
            error_code: None,
        },
    )
    .await
    .unwrap();
    let approval = Approval {
        id: Uuid::new_v4(),
        workspace_id: actor.workspace_id.clone(),
        run_id: run.id,
        requested_for_user_id: actor.user_id.clone(),
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: Risk::ReversibleWrite,
        input_hash: "a".repeat(64),
        redacted_input_summary: json!({}),
        state: ApprovalState::Pending,
        nonce: Uuid::new_v4().to_string(),
        requested_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(10),
        resolved_at: None,
        resolved_by_user_id: None,
    };
    let mut tx = f.database.begin().await.unwrap();
    approvals::create(&mut tx, &approval).await.unwrap();
    tx.commit().await.unwrap();
    let invocation = Invocation {
        id: Uuid::new_v4(),
        workspace_id: actor.workspace_id.clone(),
        user_id: actor.user_id.clone(),
        run_id: run.id,
        approval_id: approval.id,
        capability_id: approval.capability_id.clone(),
        capability_version: "1".into(),
        idempotency_key: Uuid::new_v4().to_string(),
        input_hash: approval.input_hash.clone(),
        state: InvocationState::InProgress,
        outcome: None,
        duration_ms: None,
        result: Value::Null,
        created_at: Utc::now(),
        expires_at: Utc::now() + Duration::days(1),
    };
    invocations::reserve(&f.database, &invocation)
        .await
        .unwrap();
    let preference = Preference {
        thread_id: thread.id,
        mode: SelectionMode::Auto,
        selected_connection_id: None,
        selected_model_id: None,
        selected_effort: None,
        updated_at: Utc::now(),
    };
    preferences::upsert(&f.database, &preference).await.unwrap();
    let event = json!({"threadId":thread.id,"runId":run.id,"sourceEventId":"recovery","source":"forge","type":"progress.note","occurredAt":"2026-11-01T12:00:00.000Z","payload":{"text":"Private result"}});

    f.backend.mode.store(1, Ordering::Relaxed);
    input.id = Uuid::new_v4();
    assert!(threads::create(&f.database, &input).await.is_err());
    assert!(
        threads::update(
            &f.database,
            &actor.workspace_id,
            thread.id,
            &ThreadPatch {
                title: Some("Changed".into()),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    assert!(
        runs::update(
            &f.database,
            run.id,
            &RunPatch {
                state: Some(RunState::Completed),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    assert!(events::append(&f.database, event.clone()).await.is_err());
    let mut tx = f.database.begin().await.unwrap();
    assert!(
        approvals::compare_and_set(
            &mut tx,
            approval.id,
            ApprovalState::Pending,
            ApprovalState::Approved,
            None,
            None
        )
        .await
        .is_err()
    );
    tx.rollback().await.unwrap();
    assert!(
        invocations::complete(&f.database, invocation.id, json!({"ok":true}), 0)
            .await
            .is_err()
    );
    assert!(
        invocations::release(&f.database, invocation.id)
            .await
            .is_err()
    );
    assert!(
        preferences::upsert(
            &f.database,
            &Preference {
                selected_effort: Some(Effort::Max),
                ..preference.clone()
            }
        )
        .await
        .is_err()
    );
    assert!(
        threads::get(&f.database, &actor.workspace_id, input.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        threads::get(&f.database, &actor.workspace_id, thread.id)
            .await
            .unwrap()
            .unwrap()
            .title,
        "Private chat"
    );
    assert_eq!(
        runs::get(&f.database, &actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::Created
    );
    assert!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), approval.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        ApprovalState::Pending
    );
    assert_eq!(
        preferences::get(&f.database, thread.id)
            .await
            .unwrap()
            .unwrap()
            .selected_effort,
        None
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_capability_invocations WHERE id=$1 AND state='in-progress'",
    )
    .bind(invocation.id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);

    f.backend.mode.store(0, Ordering::Relaxed);
    events::append(&f.database, event).await.unwrap();
    invocations::complete(
        &f.database,
        invocation.id,
        json!({"ok":true,"value":{"text":"Private result"}}),
        1,
    )
    .await
    .unwrap();
    invocations::release(&f.database, invocation.id)
        .await
        .unwrap();
    use forge_store::agents::approval_service::{Binding, Decision, Request, Service};
    let service = Service::new(f.database.clone());
    let request = Request {
        approval_id: Some(Uuid::new_v4()),
        run_id: run.id,
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: Risk::ReversibleWrite,
        input: json!({"slug":"fixture"}),
        redacted_input_summary: json!({"summary":"Team change"}),
        expires_at: None,
    };
    let id = request.approval_id.unwrap();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(service.request(&actor, &request).await.is_err());
    assert!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), id)
            .await
            .unwrap()
            .is_none()
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    service.request(&actor, &request).await.unwrap();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        service
            .resolve(&actor, id, Decision::Approved)
            .await
            .is_err()
    );
    assert_eq!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), id)
            .await
            .unwrap()
            .unwrap()
            .state,
        ApprovalState::Pending
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    service
        .resolve(&actor, id, Decision::Approved)
        .await
        .unwrap();
    let binding = Binding {
        run_id: run.id,
        capability_id: request.capability_id.clone(),
        capability_version: "1".into(),
        capability_input: request.input,
    };
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(service.consume(&actor, id, &binding).await.is_err());
    assert_eq!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), id)
            .await
            .unwrap()
            .unwrap()
            .state,
        ApprovalState::Approved
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    assert_eq!(
        service.consume(&actor, id, &binding).await.unwrap().state,
        ApprovalState::Consumed
    );
    let archived = f.backend.completed.lock().unwrap();
    assert!(
        archived
            .iter()
            .flat_map(|(_, events)| events)
            .any(|event| event.table == "agent_capability_invocations"
                && event.key["id"] == invocation.id.to_string()
                && event.action == forge_core::journal::RecoveryAction::Delete)
    );
    assert!(
        !serde_json::to_string(&*archived)
            .unwrap()
            .contains("Private result")
    );
}
