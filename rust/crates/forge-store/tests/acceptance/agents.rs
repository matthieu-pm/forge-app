use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_store::agents::*;
#[path = "../support/agent_blobs.rs"]
mod blobs;
#[path = "../support/model_discovery.rs"]
mod discovery;

#[path = "agent_files.rs"]
mod agent_file_acceptance;
#[path = "agent_approvals.rs"]
mod approval_service_acceptance;
#[path = "agent_capabilities.rs"]
mod capability_acceptance;
#[path = "agent_coordinator.rs"]
mod coordinator_acceptance;
#[path = "hosted_coordinator.rs"]
mod hosted_coordinator_acceptance;
#[path = "model_connections.rs"]
mod model_connection_acceptance;

fn at() -> DateTime<Utc> {
    "2026-11-01T12:00:00.000Z".parse().unwrap()
}
fn deep() -> Value {
    (0..160).fold(
        json!({"text":"Nested agent context"}),
        |value, _| json!({"child":value}),
    )
}
async fn thread(f: &Fixture) -> Thread {
    threads::create(
        &f.database,
        &CreateThread {
            id: Uuid::new_v4(),
            workspace_id: f.actor.workspace_id.clone(),
            created_by_user_id: f.actor.user_id.clone(),
            title: "Chat".into(),
            status: ThreadStatus::Active,
            runtime_kind: Runtime::Eve,
            runtime_session_id: None,
            created_at: at(),
        },
    )
    .await
    .unwrap()
}
async fn run(f: &Fixture, thread: Uuid) -> Run {
    runs::create(
        &f.database,
        &CreateRun {
            id: Uuid::new_v4(),
            thread_id: thread,
            initiated_by_user_id: f.actor.user_id.clone(),
            state: RunState::Created,
            execution_kind: Execution::ForgeNative,
            requested_selection: deep(),
            resolved_connection_id: None,
            resolved_model_id: Some("model".into()),
            reasoning_effort: Some(Effort::High),
            routing_policy_version: Some("fixture".into()),
            routing_reason: Some("Fixture route".into()),
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
    .unwrap()
}
fn event(run: &Run, source: &str) -> Value {
    json!({"threadId":run.thread_id,"runId":run.id,"sourceEventId":source,"source":"forge","type":"progress.note","occurredAt":"2026-11-01T12:00:00.000Z","schemaVersion":1,"payload":{"text":"Progress"}})
}
fn approval(f: &Fixture, run: Uuid) -> Approval {
    Approval {
        id: Uuid::new_v4(),
        workspace_id: f.actor.workspace_id.clone(),
        run_id: run,
        requested_for_user_id: f.actor.user_id.clone(),
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: Risk::ReversibleWrite,
        input_hash: "a".repeat(64),
        redacted_input_summary: deep(),
        state: ApprovalState::Pending,
        nonce: Uuid::new_v4().to_string(),
        requested_at: at(),
        expires_at: at() + Duration::minutes(10),
        resolved_at: None,
        resolved_by_user_id: None,
    }
}
async fn save_approval(f: &Fixture, input: &Approval) -> Approval {
    let mut tx = f.database.begin().await.unwrap();
    let row = approvals::create(&mut tx, input).await.unwrap();
    tx.commit().await.unwrap();
    row
}
fn invocation(f: &Fixture, approval: &Approval) -> Invocation {
    Invocation {
        id: Uuid::new_v4(),
        workspace_id: f.actor.workspace_id.clone(),
        user_id: f.actor.user_id.clone(),
        run_id: approval.run_id,
        approval_id: approval.id,
        capability_id: approval.capability_id.clone(),
        capability_version: approval.capability_version.clone(),
        idempotency_key: Uuid::new_v4().to_string(),
        input_hash: approval.input_hash.clone(),
        state: InvocationState::InProgress,
        outcome: None,
        duration_ms: None,
        result: Value::Null,
        created_at: at(),
        expires_at: at() + Duration::hours(24),
    }
}

#[tokio::test]
async fn agent_threads_preserve_workspace_filters_nullable_patches_and_latest_run_state() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let original = thread(&f).await;
    assert_eq!(original.last_run_state, None);
    assert_eq!(
        serde_json::to_value(&original).unwrap()["createdAt"],
        "2026-11-01T12:00:00.000Z"
    );
    assert!(
        threads::get(&f.database, &other.actor.workspace_id, original.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        threads::list(&f.database, &f.actor.workspace_id, &other.actor.user_id)
            .await
            .unwrap()
            .is_empty()
    );
    let first = run(&f, original.id).await;
    assert_eq!(first.requested_selection, deep());
    let latest = run(&f, original.id).await;
    sqlx::query("UPDATE agent_runs SET created_at=created_at+interval '1 minute',state='failed' WHERE id=$1").bind(latest.id).execute(&f.pool).await.unwrap();
    let patch = ThreadPatch {
        title: Some("Renamed".into()),
        status: Some(ThreadStatus::Archived),
        runtime_kind: Some(Runtime::Codex),
        runtime_session_id: Some(Some("native-session".into())),
        last_activity_at: Some(at() + Duration::hours(1)),
    };
    let updated = threads::update(&f.database, &f.actor.workspace_id, original.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.title, "Renamed");
    assert_eq!(updated.status, ThreadStatus::Archived);
    assert_eq!(updated.last_run_state, Some(RunState::Failed));
    assert_eq!(updated.created_at, original.created_at);
    assert_eq!(updated.last_activity_at, patch.last_activity_at.unwrap());
    let kept = threads::update(
        &f.database,
        &f.actor.workspace_id,
        original.id,
        &ThreadPatch::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(kept.runtime_session_id, Some("native-session".into()));
    let cleared = threads::update(
        &f.database,
        &f.actor.workspace_id,
        original.id,
        &ThreadPatch {
            runtime_session_id: Some(None),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(cleared.runtime_session_id, None);
    assert!(
        threads::update(&f.database, &other.actor.workspace_id, original.id, &patch)
            .await
            .unwrap()
            .is_none()
    );
    let newer = thread(&f).await;
    let listed = threads::list(&f.database, &f.actor.workspace_id, &f.actor.user_id)
        .await
        .unwrap();
    assert_eq!(
        listed.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![original.id, newer.id]
    );
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
    sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,thread_id,agent_run_id) VALUES($1,$2,$3,1,'agent-list',$4,'{}','{}',$5,'completed',$6,$7)")
        .bind(Uuid::new_v4()).bind(&f.actor.workspace_id).bind(loop_id).bind("a".repeat(64)).bind(&f.actor.user_id).bind(original.id).bind(first.id).execute(&f.pool).await.unwrap();
    let listed = threads::list(&f.database, &f.actor.workspace_id, &f.actor.user_id)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, newer.id);
    assert!(
        threads::get(&f.database, &f.actor.workspace_id, original.id)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn agent_runs_preserve_counters_runtime_identity_and_usage_window_boundaries() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let thread = thread(&f).await;
    let first = run(&f, thread.id).await;
    assert!(
        runs::get(&f.database, &other.actor.workspace_id, first.id)
            .await
            .unwrap()
            .is_none()
    );
    let patch = RunPatch {
        state: Some(RunState::Completed),
        runtime_run_id: Some(Some("remote-run".into())),
        input_tokens: Some(100),
        output_tokens: Some(20),
        cached_input_tokens: Some(50),
        cost_micros: Some(200),
        started_at: Some(Some(at())),
        completed_at: Some(Some(at() + Duration::seconds(1))),
        error_code: Some(Some("Old error".into())),
    };
    let updated = runs::update(&f.database, first.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.input_tokens, 100);
    assert_eq!(updated.output_tokens, 20);
    assert_eq!(updated.cached_input_tokens, 50);
    assert_eq!(updated.started_at, Some(at()));
    assert_eq!(updated.completed_at, Some(at() + Duration::seconds(1)));
    let kept = runs::update(&f.database, first.id, &RunPatch::default())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.runtime_run_id, updated.runtime_run_id);
    let second = run(&f, thread.id).await;
    assert!(runs::update(&f.database, second.id, &patch).await.is_err());
    assert_eq!(
        runs::get(&f.database, &f.actor.workspace_id, second.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::Created
    );
    assert!(
        runs::update(
            &f.database,
            first.id,
            &RunPatch {
                cost_micros: Some(-1),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    let cleared = runs::update(
        &f.database,
        first.id,
        &RunPatch {
            runtime_run_id: Some(None),
            started_at: Some(None),
            completed_at: Some(None),
            error_code: Some(None),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        (
            cleared.runtime_run_id,
            cleared.started_at,
            cleared.completed_at,
            cleared.error_code
        ),
        (None, None, None, None)
    );
    sqlx::query("UPDATE agent_runs SET created_at=$2 WHERE id=$1")
        .bind(first.id)
        .bind(at())
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_runs SET created_at=$2,cost_micros=300 WHERE id=$1")
        .bind(second.id)
        .bind(at() + Duration::days(1))
        .execute(&f.pool)
        .await
        .unwrap();
    let third = run(&other, thread.id).await;
    sqlx::query("UPDATE agent_runs SET created_at=$2,cost_micros=400 WHERE id=$1")
        .bind(third.id)
        .bind(at())
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        runs::usage(
            &f.database,
            &f.actor.workspace_id,
            None,
            at(),
            Some(at() + Duration::days(1))
        )
        .await
        .unwrap(),
        Usage {
            cost_micros: 600,
            active_runs: 2
        }
    );
    assert_eq!(
        runs::usage(
            &f.database,
            &f.actor.workspace_id,
            Some(&f.actor.user_id),
            at(),
            Some(at() + Duration::days(1))
        )
        .await
        .unwrap(),
        Usage {
            cost_micros: 200,
            active_runs: 1
        }
    );
    assert_eq!(
        runs::usage(
            &f.database,
            &f.actor.workspace_id,
            None,
            at() + Duration::days(2),
            None
        )
        .await
        .unwrap(),
        Usage {
            cost_micros: 0,
            active_runs: 2
        }
    );
    assert_eq!(
        runs::usage(&f.database, &other.actor.workspace_id, None, at(), None)
            .await
            .unwrap(),
        Usage {
            cost_micros: 0,
            active_runs: 0
        }
    );
    assert!(
        runs::usage(&f.database, &f.actor.workspace_id, None, at(), Some(at()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn agent_event_replays_are_safe_concurrent_and_sequences_remain_run_local() {
    let f = Fixture::new().await;
    let thread = thread(&f).await;
    let first = run(&f, thread.id).await;
    let input = event(&first, "source-1");
    let copies =
        futures_util::future::join_all((0..8).map(|_| events::append(&f.database, input.clone())))
            .await;
    let copies: Vec<_> = copies.into_iter().map(Result::unwrap).collect();
    assert!(
        copies
            .iter()
            .all(|r| r.id == copies[0].id && r.sequence == 1)
    );
    let mut replay = input.clone();
    replay["source"] = json!("codex");
    replay["payload"] = json!({"text":"Changed safe payload"});
    assert_eq!(
        events::append(&f.database, replay.clone()).await.unwrap(),
        copies[0]
    );
    replay["payload"] = json!({"access_token":"hidden credential"});
    assert!(events::append(&f.database, replay).await.is_err());
    let different = futures_util::future::join_all(
        (0..4).map(|i| events::append(&f.database, event(&first, &format!("source-extra-{i}")))),
    )
    .await;
    assert!(different.into_iter().all(|r| r.is_ok()));
    let mut nested = event(&first, "deep");
    nested["payload"] = deep();
    assert_eq!(
        events::append(&f.database, nested).await.unwrap().payload,
        deep()
    );
    let list = events::list_run(&f.database, first.id, -100).await.unwrap();
    assert_eq!(
        list.iter().map(|r| r.sequence).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    assert_eq!(
        events::list_run(&f.database, first.id, 5)
            .await
            .unwrap()
            .len(),
        1
    );
    let second = run(&f, thread.id).await;
    let mut input = event(&second, "source-1");
    input["occurredAt"] = json!("2026-11-01T12:00:01.000Z");
    assert_eq!(
        events::append(&f.database, input.clone())
            .await
            .unwrap()
            .sequence,
        1
    );
    input["sourceEventId"] = json!("source-2");
    assert_eq!(
        events::append(&f.database, input).await.unwrap().sequence,
        2
    );
    let list = events::list_thread(&f.database, thread.id, 1)
        .await
        .unwrap();
    assert_eq!(
        list.iter().map(|r| r.sequence).collect::<Vec<_>>(),
        vec![2, 3, 4, 5, 6, 2]
    );
    assert_eq!(list.last().unwrap().run_id, second.id);
    assert_eq!(
        serde_json::to_value(list.last().unwrap()).unwrap()["occurredAt"],
        "2026-11-01T12:00:01.000Z"
    );
}

#[tokio::test]
async fn agent_approvals_race_atomically_preserve_original_identity_and_roll_back_with_events() {
    let f = Fixture::new().await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let input = approval(&f, run.id);
    assert_eq!(save_approval(&f, &input).await, input);
    let mut replay = input.clone();
    replay.input_hash = "b".repeat(64);
    assert_eq!(save_approval(&f, &replay).await, input);
    let races = futures_util::future::join_all(
        [ApprovalState::Approved, ApprovalState::Denied]
            .into_iter()
            .map(|next| {
                let f = &f;
                let input = &input;
                async move {
                    let mut tx = f.database.begin().await.unwrap();
                    let row = approvals::compare_and_set(
                        &mut tx,
                        input.id,
                        ApprovalState::Pending,
                        next,
                        Some(at()),
                        Some(&f.actor.user_id),
                    )
                    .await
                    .unwrap();
                    tx.commit().await.unwrap();
                    row
                }
            }),
    )
    .await;
    assert_eq!(races.iter().filter(|r| r.is_some()).count(), 1);
    let winner = races.into_iter().flatten().next().unwrap();
    assert_eq!(winner.resolved_at, Some(at()));
    assert_eq!(winner.resolved_by_user_id, Some(f.actor.user_id.clone()));
    let mut tx = f.database.begin().await.unwrap();
    assert!(
        approvals::compare_and_set(
            &mut tx,
            input.id,
            ApprovalState::Pending,
            ApprovalState::Approved,
            None,
            None
        )
        .await
        .unwrap()
        .is_none()
    );
    tx.rollback().await.unwrap();
    let mut duplicate = approval(&f, run.id);
    duplicate.nonce = input.nonce.clone();
    let mut tx = f.database.begin().await.unwrap();
    assert!(approvals::create(&mut tx, &duplicate).await.is_err());
    tx.rollback().await.unwrap();
    let pending = approval(&f, run.id);
    let mut tx = f.database.begin().await.unwrap();
    approvals::create(&mut tx, &pending).await.unwrap();
    events::append_in(&mut tx, event(&run, "atomic-approval"))
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), pending.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let mut tx = f.database.begin().await.unwrap();
    approvals::create(&mut tx, &pending).await.unwrap();
    events::append_in(&mut tx, event(&run, "atomic-approval"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn agent_approval_queries_bind_all_identity_fields_without_implicitly_consuming_grants() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let mut input = approval(&f, run.id);
    input.state = ApprovalState::Approved;
    input.capability_id = "program.execute".into();
    save_approval(&f, &input).await;
    let mut query = approvals::ApprovedQuery {
        workspace_id: &f.actor.workspace_id,
        run_id: run.id,
        requested_for_user_id: &f.actor.user_id,
        capability_id: "program.execute",
        capability_version: "1",
        input_hash: &input.input_hash,
    };
    let mut conn = f.pool.acquire().await.unwrap();
    // The service must check time and fresh authority after lookup; expired rows
    // are deliberately returned just as they are by the existing adapter.
    assert_eq!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .unwrap(),
        input
    );
    query.workspace_id = &other.actor.workspace_id;
    assert!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .is_none()
    );
    query.workspace_id = &f.actor.workspace_id;
    query.requested_for_user_id = &other.actor.user_id;
    assert!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .is_none()
    );
    query.requested_for_user_id = &f.actor.user_id;
    query.run_id = Uuid::new_v4();
    assert!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .is_none()
    );
    query.run_id = run.id;
    query.capability_id = "teams.update";
    assert!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .is_none()
    );
    query.capability_id = "program.execute";
    query.capability_version = "2";
    assert!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .is_none()
    );
    query.capability_version = "1";
    query.input_hash = "different";
    assert!(
        approvals::find_approved(&mut conn, &query)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        approvals::list_program_grants(&mut conn, &f.actor.workspace_id, run.id, &f.actor.user_id)
            .await
            .unwrap()
            .len(),
        1
    );
    let mut tx = f.database.begin().await.unwrap();
    approvals::compare_and_set(
        &mut tx,
        input.id,
        ApprovalState::Approved,
        ApprovalState::Consumed,
        None,
        Some(""),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(
        approvals::list_program_grants(&mut conn, &f.actor.workspace_id, run.id, &f.actor.user_id)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn agent_capability_reservations_are_exclusive_replay_results_and_release_transactionally() {
    let f = Fixture::new().await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let approval = save_approval(&f, &approval(&f, run.id)).await;
    let input = invocation(&f, &approval);
    let requests: Vec<_> = (0..8)
        .map(|_| Invocation {
            id: Uuid::new_v4(),
            ..input.clone()
        })
        .collect();
    let rows = futures_util::future::join_all(
        requests
            .iter()
            .map(|r| invocations::reserve(&f.database, r)),
    )
    .await;
    let mut reserved = Vec::new();
    let mut existing = Vec::new();
    for row in rows {
        match row.unwrap() {
            invocations::Reservation::Reserved(row) => reserved.push(row),
            invocations::Reservation::Existing(row) => existing.push(row),
        }
    }
    assert_eq!(reserved.len(), 1);
    assert_eq!(existing.len(), 7);
    let id = reserved[0].id;
    assert!(existing.iter().all(|r| r.id == id));
    let mut changed = input.clone();
    changed.input_hash = "b".repeat(64);
    match invocations::reserve(&f.database, &changed).await.unwrap() {
        invocations::Reservation::Existing(row) => assert_eq!(row.input_hash, input.input_hash),
        _ => panic!("must preserve original hash for service comparison"),
    };
    assert!(
        invocations::complete(&f.database, id, Value::Null, 5)
            .await
            .unwrap()
            .is_none()
    );
    let result = json!({"ok":true,"value":deep()});
    let complete = invocations::complete(&f.database, id, result.clone(), 125)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(complete.state, InvocationState::Completed);
    assert_eq!(complete.outcome, Some(Outcome::Succeeded));
    assert_eq!(complete.duration_ms, Some(125));
    assert_eq!(complete.result, result);
    match invocations::reserve(&f.database, &input).await.unwrap() {
        invocations::Reservation::Existing(row) => assert_eq!(row, complete),
        _ => panic!("must replay result"),
    };
    assert!(
        invocations::complete(&f.database, id, json!({"ok":false}), 0)
            .await
            .is_err()
    );
    assert!(
        invocations::complete(&f.database, id, json!({"ok":true}), -1)
            .await
            .is_err()
    );
    let failed = invocations::complete(
        &f.database,
        id,
        json!({"ok":false,"errorCode":"FAILED","errorMessage":"Action failed"}),
        200,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(failed.outcome, Some(Outcome::Failed));
    let mut collision = input.clone();
    collision.id = id;
    collision.idempotency_key = "new-key".into();
    assert!(invocations::reserve(&f.database, &collision).await.is_err());
    invocations::release(&f.database, id).await.unwrap();
    invocations::release(&f.database, id).await.unwrap();
    assert!(matches!(
        invocations::reserve(&f.database, &input).await.unwrap(),
        invocations::Reservation::Reserved(_)
    ));
}

#[tokio::test]
async fn agent_model_preferences_round_trip_modes_and_reject_invalid_persistence() {
    let f = Fixture::new().await;
    let thread = thread(&f).await;
    assert!(
        preferences::get(&f.database, thread.id)
            .await
            .unwrap()
            .is_none()
    );
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO model_connections(id,workspace_id,user_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,created_by_user_id) VALUES($1,$2,$3,'personal','openai','api-key','forge-native','server-capable','pay-as-you-go','forge-server-vault','Fixture',$3)")
        .bind(connection).bind(&f.actor.workspace_id).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    let mut input = Preference {
        thread_id: thread.id,
        mode: SelectionMode::Auto,
        selected_connection_id: None,
        selected_model_id: None,
        selected_effort: Some(Effort::High),
        updated_at: at(),
    };
    assert_eq!(
        preferences::upsert(&f.database, &input).await.unwrap(),
        input
    );
    input.mode = SelectionMode::Manual;
    input.selected_connection_id = Some(connection);
    input.selected_model_id = Some("gpt-model".into());
    input.updated_at += Duration::seconds(1);
    assert_eq!(
        preferences::upsert(&f.database, &input).await.unwrap(),
        input
    );
    let mut invalid = input.clone();
    invalid.selected_model_id = None;
    assert!(preferences::upsert(&f.database, &invalid).await.is_err());
    assert_eq!(
        preferences::get(&f.database, thread.id).await.unwrap(),
        Some(input.clone())
    );
    input.mode = SelectionMode::Auto;
    input.selected_connection_id = None;
    input.selected_model_id = None;
    input.selected_effort = None;
    assert_eq!(
        preferences::upsert(&f.database, &input).await.unwrap(),
        input
    );
    assert_eq!(
        preferences::get(&f.database, thread.id).await.unwrap(),
        Some(input)
    );
}
