use super::*;
use forge_core::agents::approval::Code;
use forge_store::agents::approval_service::{Binding, Decision, Request, Service};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

fn service(f: &Fixture) -> (Service, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(at().timestamp_millis()));
    let read = clock.clone();
    (
        Service::new(f.database.clone()).with_clock(Arc::new(move || {
            DateTime::from_timestamp_millis(read.load(Ordering::SeqCst)).unwrap()
        })),
        clock,
    )
}
fn request(run: Uuid) -> Request {
    Request {
        approval_id: Some(Uuid::new_v4()),
        run_id: run,
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: Risk::ReversibleWrite,
        input: json!({"slug":"forge","settings":{"description":"Updated"}}),
        redacted_input_summary: json!({"summary":"Update team"}),
        expires_at: None,
    }
}
fn binding(request: &Request) -> Binding {
    Binding {
        run_id: request.run_id,
        capability_id: request.capability_id.clone(),
        capability_version: request.capability_version.clone(),
        capability_input: request.input.clone(),
    }
}
fn code<T: std::fmt::Debug>(result: Result<T, StoreError>, code: Code) {
    match result.unwrap_err() {
        StoreError::Approval(error) => assert_eq!(error.code, code),
        error => panic!("Unexpected {error:?}"),
    }
}
async fn running(f: &Fixture) -> Run {
    let thread = thread(f).await;
    let run = run(f, thread.id).await;
    runs::update(
        &f.database,
        run.id,
        &RunPatch {
            state: Some(RunState::Running),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .unwrap()
}
fn agent(f: &Fixture, run: Uuid) -> Actor {
    Actor {
        authentication: Authentication::Agent {
            run_id: run.to_string(),
            token_id: Uuid::new_v4().to_string(),
        },
        scopes: Some(vec![
            ApiScope::TeamsRead,
            ApiScope::TeamsWrite,
            ApiScope::AgentsWrite,
        ]),
        ..f.actor.clone()
    }
}

#[tokio::test]
async fn approval_lifecycles_match_exported_reference_service_flows() {
    let data: Value =
        serde_json::from_str(include_str!("../../../../reference-fixtures.json")).unwrap();
    for (index, flow) in data["agentApprovals"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let f = Fixture::new().await;
        let run = running(&f).await;
        let (service, clock) = service(&f);
        let base = request(run.id);
        let id = base.approval_id.unwrap();
        for case in flow.as_array().unwrap() {
            let step = &case["step"];
            clock.fetch_add(step["advance"].as_i64().unwrap_or(0), Ordering::SeqCst);
            let mut input = base.clone();
            if step["changedInput"] == true {
                input.input["slug"] = json!("changed");
            }
            let mut binding = binding(&input);
            if let Some(capability) = step["capability"].as_str() {
                binding.capability_id = capability.into();
            }
            if let Some(version) = step["version"].as_str() {
                binding.capability_version = version.into();
            }
            if step["wrongRun"] == true {
                binding.run_id = run.thread_id;
            }
            let result: Result<Value, StoreError> = match step["op"].as_str().unwrap() {
                "request" => {
                    if step["program"] == true {
                        input.capability_id = "program.execute".into();
                        input.input = json!({"code":"fixture","capabilityManifest":[{"id":"teams.update","version":"1","maximumCalls":1}]});
                        input.redacted_input_summary = json!({"summary":"Program","details":{"programManifest":[{"id":"teams.update","version":"1","maximumCalls":1}]}});
                    }
                    if let Some(ms) = step["expiresAfterMs"].as_i64() {
                        input.expires_at = Some(
                            DateTime::from_timestamp_millis(clock.load(Ordering::SeqCst) + ms)
                                .unwrap(),
                        );
                    }
                    service.request(&f.actor, &input).await.map(
                        |r| json!({"ok":true,"state":r.approval.state,"eventType":r.event.kind}),
                    )
                }
                "resolve" => service
                    .resolve(
                        &f.actor,
                        id,
                        serde_json::from_value(step["decision"].clone()).unwrap(),
                    )
                    .await
                    .map(|r| json!({"ok":true,"state":r.approval.state,"eventType":r.event.kind})),
                "consume" => service
                    .consume(&f.actor, id, &binding)
                    .await
                    .map(|r| json!({"ok":true,"state":r.state,"eventType":null})),
                "find" => service
                    .find_approved(&f.actor, &binding)
                    .await
                    .map(|r| json!({"ok":true,"state":r.map(|r|r.state),"eventType":null})),
                _ => unreachable!(),
            };
            let mut output = match result {
                Ok(v) => v,
                Err(StoreError::Approval(error)) => {
                    json!({"ok":false,"code":error.code,"message":error.message})
                }
                Err(error) => panic!("flow {index}, step {step}: {error:?}"),
            };
            output["runState"] = serde_json::to_value(
                runs::get(&f.database, &f.actor.workspace_id, run.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .state,
            )
            .unwrap();
            output["storedState"] = serde_json::to_value(
                approvals::get(&mut f.pool.acquire().await.unwrap(), id)
                    .await
                    .unwrap()
                    .map(|a| a.state),
            )
            .unwrap();
            output["eventCount"] = json!(
                events::list_run(&f.database, run.id, 0)
                    .await
                    .unwrap()
                    .len()
            );
            assert_eq!(output, case["output"], "flow {index}, step {step}");
        }
    }
}

#[tokio::test]
async fn approval_authority_rechecks_live_session_membership_scopes_and_run_binding() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let run = running(&f).await;
    let other_run = running(&f).await;
    let (service, _) = service(&f);
    let input = request(run.id);
    let id = input.approval_id.unwrap();
    let resolution = service.request(&f.actor, &input).await.unwrap();
    assert_eq!(
        resolution.approval.input_hash,
        forge_core::agents::approval::input_hash(&input.input)
    );
    assert!(
        !serde_json::to_string(&resolution.event)
            .unwrap()
            .contains("Updated")
    );
    code(
        service.resolve(&member, id, Decision::Approved).await,
        Code::ApprovalBindingMismatch,
    );
    code(
        service.request(&member, &request(run.id)).await,
        Code::ApprovalBindingMismatch,
    );
    code(
        service
            .request(&agent(&f, other_run.id), &request(run.id))
            .await,
        Code::ApprovalBindingMismatch,
    );
    assert!(matches!(
        service
            .resolve(&agent(&f, run.id), id, Decision::Approved)
            .await,
        Err(StoreError::Forbidden)
    ));
    let key = team_key(&f).await;
    assert!(matches!(
        service.request(&key, &request(run.id)).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.resolve(&key, id, Decision::Approved).await,
        Err(StoreError::Forbidden)
    ));
    service
        .resolve(&f.actor, id, Decision::Approved)
        .await
        .unwrap();
    let bound = binding(&input);
    assert!(
        service
            .find_approved(&agent(&f, other_run.id), &bound)
            .await
            .unwrap()
            .is_none()
    );
    code(
        service.consume(&agent(&f, other_run.id), id, &bound).await,
        Code::ApprovalBindingMismatch,
    );
    assert_eq!(
        service
            .find_approved(&agent(&f, run.id), &bound)
            .await
            .unwrap()
            .unwrap()
            .id,
        id
    );
    // Revoking the browser session also blocks old actor snapshots and replays.
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.request(&f.actor, &input).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.consume(&f.actor, id, &bound).await,
        Err(StoreError::Forbidden)
    ));
    // A run credential has its own live membership/run checks.
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.consume(&agent(&f, run.id), id, &bound).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), id)
            .await
            .unwrap()
            .unwrap()
            .state,
        ApprovalState::Approved
    );
}

#[tokio::test]
async fn approvals_are_resolved_and_consumed_once_under_concurrency() {
    let f = Fixture::new().await;
    let run = running(&f).await;
    let (service, _) = service(&f);
    let input = request(run.id);
    let id = input.approval_id.unwrap();
    let requests =
        futures_util::future::join_all((0..6).map(|_| service.request(&f.actor, &input))).await;
    assert!(requests.into_iter().all(|r| r.is_ok()));
    assert_eq!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    let resolutions = futures_util::future::join_all(
        (0..6).map(|_| service.resolve(&f.actor, id, Decision::Approved)),
    )
    .await;
    assert_eq!(resolutions.iter().filter(|r| r.is_ok()).count(), 1);
    for result in resolutions.into_iter().filter(Result::is_err) {
        code(result, Code::ApprovalNotPending);
    }
    assert_eq!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .len(),
        2
    );
    let bound = binding(&input);
    let actor = agent(&f, run.id);
    let consumed =
        futures_util::future::join_all((0..6).map(|_| service.consume(&actor, id, &bound))).await;
    assert_eq!(consumed.iter().filter(|r| r.is_ok()).count(), 1);
    for result in consumed.into_iter().filter(Result::is_err) {
        code(result, Code::ApprovalNotApproved);
    }
}

#[tokio::test]
async fn approval_events_and_run_state_roll_back_when_event_publication_fails() {
    let f = Fixture::new().await;
    let run = running(&f).await;
    let (service, _) = service(&f);
    let input = request(run.id);
    let id = input.approval_id.unwrap();
    let mut unsafe_input = input.clone();
    unsafe_input.redacted_input_summary = json!({"password":"private"});
    assert!(service.request(&f.actor, &unsafe_input).await.is_err());
    assert!(
        approvals::get(&mut f.pool.acquire().await.unwrap(), id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
    service.request(&f.actor, &input).await.unwrap();
    // Inject failure only for this run. Other concurrent acceptance fixtures
    // retain their ordinary event behavior.
    let name = format!("approval_fail_{}", Uuid::new_v4().simple());
    let sql = format!(
        "CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='{}'::uuid AND NEW.type='approval.resolved' THEN RAISE EXCEPTION 'fixture event failure'; END IF; RETURN NEW; END $$",
        run.id
    );
    sqlx::query(&sql).execute(&f.pool).await.unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {name} BEFORE INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION {name}()"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(
        service
            .resolve(&f.actor, id, Decision::Approved)
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
    assert_eq!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::WaitingForApproval
    );
    assert_eq!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::query(&format!("DROP TRIGGER {name} ON agent_events"))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {name}()"))
        .execute(&f.pool)
        .await
        .unwrap();
    service
        .resolve(&f.actor, id, Decision::Approved)
        .await
        .unwrap();
}

#[tokio::test]
async fn approved_program_grants_remain_bound_and_expired_exact_approvals_do_not_fall_back() {
    let f = Fixture::new().await;
    let run = running(&f).await;
    let (service, clock) = service(&f);
    let input = request(run.id);
    let id = input.approval_id.unwrap();
    service.request(&f.actor, &input).await.unwrap();
    service
        .resolve(&f.actor, id, Decision::Approved)
        .await
        .unwrap();
    let mut program = request(run.id);
    program.capability_id = "program.execute".into();
    program.input = json!({"code":"approved"});
    program.expires_at = Some(at() + Duration::days(1));
    program.redacted_input_summary =
        json!({"details":{"programManifest":[{"id":"teams.update","version":"1"}]}});
    service.request(&f.actor, &program).await.unwrap();
    service
        .resolve(&f.actor, program.approval_id.unwrap(), Decision::Approved)
        .await
        .unwrap();
    let bound = binding(&input);
    clock.store(
        (at() + Duration::minutes(6)).timestamp_millis(),
        Ordering::SeqCst,
    );
    assert!(
        service
            .find_approved(&f.actor, &bound)
            .await
            .unwrap()
            .is_none()
    );
    let grant = service
        .consume(&agent(&f, run.id), program.approval_id.unwrap(), &bound)
        .await
        .unwrap();
    assert_eq!(grant.state, ApprovalState::Approved);
    assert_eq!(
        service
            .consume(&agent(&f, run.id), program.approval_id.unwrap(), &bound)
            .await
            .unwrap()
            .state,
        ApprovalState::Approved
    );
    let mut wrong = bound.clone();
    wrong.capability_version = "2".into();
    code(
        service
            .consume(&f.actor, program.approval_id.unwrap(), &wrong)
            .await,
        Code::ApprovalBindingMismatch,
    );
    clock.store(
        (at() + Duration::days(1)).timestamp_millis(),
        Ordering::SeqCst,
    );
    code(
        service
            .consume(&f.actor, program.approval_id.unwrap(), &bound)
            .await,
        Code::ApprovalExpired,
    );
}
