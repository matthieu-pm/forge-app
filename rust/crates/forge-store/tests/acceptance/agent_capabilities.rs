use super::*;
use forge_store::agents::{
    approval_service::{Decision, Request, Service},
    capabilities::{ArtifactCreator, Gateway},
};
use std::sync::Arc;

async fn ready(f: &Fixture) -> (Gateway, Run, forge_core::teams::TeamSummary) {
    let thread = thread(f).await;
    let run = run(f, thread.id).await;
    let run = runs::update(
        &f.database,
        run.id,
        &RunPatch {
            state: Some(RunState::Running),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    let team = forge_store::teams::create(&f.database, &f.actor, &team_input(0))
        .await
        .unwrap();
    (Gateway::new(f.database.clone()), run, team)
}
fn call(capability: &str, input: Value) -> Value {
    json!({"capabilityId":capability,"capabilityVersion":"1","input":input})
}
async fn approved(f: &Fixture, run: Uuid, slug: &str, settings: Value) -> Value {
    let input = json!({"slug":slug,"settings":settings});
    let service = Service::new(f.database.clone());
    let request = Request {
        approval_id: None,
        run_id: run,
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: Risk::ReversibleWrite,
        input: input.clone(),
        redacted_input_summary: json!({"summary":"Team settings"}),
        expires_at: None,
    };
    let approval = service.request(&f.actor, &request).await.unwrap().approval;
    service
        .resolve(&f.actor, approval.id, Decision::Approved)
        .await
        .unwrap();
    let mut invocation = call("teams.update", input);
    invocation["approvalId"] = json!(approval.id);
    invocation["idempotencyKey"] = json!(Uuid::new_v4());
    invocation
}
async fn counts(f: &Fixture) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM command_receipts WHERE workspace_id=$1),(SELECT count(*) FROM command_audit_events WHERE workspace_id=$1),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1)").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap()
}
async fn state(f: &Fixture, invocation: &Value) -> ApprovalState {
    approvals::get(
        &mut f.pool.acquire().await.unwrap(),
        invocation["approvalId"].as_str().unwrap().parse().unwrap(),
    )
    .await
    .unwrap()
    .unwrap()
    .state
}
fn actor(f: &Fixture, run: Uuid) -> Actor {
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
async fn capabilities_check_current_authority_before_policy_inputs_and_private_reads() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let (gateway, run, team) = ready(&f).await;
    let member = enter_workspace(&f, &other).await;
    let second = forge_store::teams::create(&f.database, &f.actor, &team_input(1))
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(second.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let list = gateway
        .invoke(&member, call("teams.list", json!({})), run.id)
        .await;
    assert_eq!(list["ok"], true);
    assert_eq!(list["value"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        gateway
            .invoke(&member, call("teams.get", json!({"id":second.id})), run.id)
            .await,
        json!({"ok":true,"value":null})
    );
    let get = gateway
        .invoke(
            &f.actor,
            call("teams.get", json!({"slug":team.slug})),
            run.id,
        )
        .await;
    assert_eq!(get["value"]["id"], team.id.to_string());
    let page = gateway
        .invoke(&f.actor, call("teams.list", json!({"limit":1})), run.id)
        .await;
    assert!(page["value"]["nextCursor"].is_string());
    let next = gateway
        .invoke(
            &f.actor,
            call(
                "teams.list",
                json!({"cursor":page["value"]["nextCursor"],"limit":1}),
            ),
            run.id,
        )
        .await;
    assert_ne!(
        page["value"]["items"][0]["id"],
        next["value"]["items"][0]["id"]
    );
    let described = gateway
        .invoke(&f.actor, call("workspace.describe", json!({})), run.id)
        .await;
    assert_eq!(described["value"]["actorRole"], "admin");
    assert_eq!(described["value"]["id"], f.actor.workspace_id);
    for input in [json!({"limit":0}), json!({"limit":101}), json!({"extra":1})] {
        assert_eq!(
            gateway
                .invoke(&f.actor, call("teams.list", input), run.id)
                .await["errorCode"],
            "INVALID_CAPABILITY_INPUT"
        );
    }
    assert_eq!(
        gateway
            .invoke(
                &f.actor,
                call("teams.list", json!({"cursor":"not-a-cursor"})),
                run.id
            )
            .await["errorCode"],
        "CAPABILITY_EXECUTION_FAILED"
    );
    let mut unknown = call("teams.list", json!({}));
    unknown["capabilityVersion"] = json!("2");
    assert_eq!(
        gateway.invoke(&f.actor, unknown, run.id).await["errorCode"],
        "CAPABILITY_NOT_FOUND"
    );
    assert_eq!(
        gateway
            .invoke(&f.actor, call("unknown.read", json!({})), run.id)
            .await["errorCode"],
        "FORBIDDEN"
    );
    let blocked = gateway.clone().with_allowed(Some(Default::default()));
    assert_eq!(
        blocked
            .invoke(&f.actor, call("teams.list", json!({"extra":1})), run.id)
            .await["errorCode"],
        "POLICY_BLOCKED"
    );
    assert_eq!(
        gateway
            .invoke(
                &f.actor,
                call(
                    "teams.update",
                    json!({"slug":format!(" {} ",team.slug),"settings":{"description":"x"}})
                ),
                run.id
            )
            .await["errorCode"],
        "FORBIDDEN"
    );
    let bound = actor(&f, run.id);
    assert_eq!(
        gateway
            .invoke(&bound, call("teams.list", json!({})), Uuid::new_v4())
            .await["errorCode"],
        "RUN_BINDING_MISMATCH"
    );
    sqlx::query("UPDATE agent_runs SET state='completed' WHERE id=$1")
        .bind(run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        gateway
            .invoke(&bound, call("teams.list", json!({})), run.id)
            .await["errorCode"],
        "FORBIDDEN"
    );
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        blocked
            .invoke(&f.actor, call("teams.list", json!({})), run.id)
            .await["errorCode"],
        "FORBIDDEN"
    );
}

#[tokio::test]
async fn approved_capability_commands_are_atomic_replayable_and_reauthorize_saved_targets() {
    let f = Fixture::new().await;
    let (gateway, run, team) = ready(&f).await;
    let invocation = approved(
        &f,
        run.id,
        &team.slug,
        json!({"description":"Approved change"}),
    )
    .await;
    let actor = actor(&f, run.id);
    let results = futures_util::future::join_all(
        (0..8).map(|_| gateway.invoke(&actor, invocation.clone(), run.id)),
    )
    .await;
    assert!(results.iter().all(|r| r["ok"] == true), "{results:?}");
    assert!(results.iter().all(|r| r == &results[0]));
    assert_eq!(state(&f, &invocation).await, ApprovalState::Consumed);
    assert_eq!(counts(&f).await, (1, 1, 1));
    let actual = forge_store::teams::get(
        &f.database,
        &f.actor,
        &forge_store::teams::Selector::Id(team.id),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(actual.description, "Approved change");
    let mut replay = invocation.clone();
    replay.as_object_mut().unwrap().remove("approvalId");
    assert_eq!(
        gateway.invoke(&actor, replay.clone(), run.id).await,
        results[0]
    );
    replay["input"]["settings"]["description"] = json!("different");
    assert_eq!(
        gateway.invoke(&actor, replay, run.id).await["errorCode"],
        "IDEMPOTENCY_KEY_CONFLICT"
    );
    let mut changed = invocation.clone();
    changed["idempotencyKey"] = json!(Uuid::new_v4());
    assert_eq!(
        gateway.invoke(&actor, changed, run.id).await["errorCode"],
        "APPROVAL_NOT_APPROVED"
    );
    assert_eq!(counts(&f).await, (1, 1, 1));
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        gateway.invoke(&actor, invocation.clone(), run.id).await["errorCode"],
        "FORBIDDEN"
    );
    sqlx::query("UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    forge_store::teams::archive(
        &f.database,
        &f.actor,
        &forge_store::teams::Selector::Id(team.id),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        gateway.invoke(&actor, invocation, run.id).await["errorCode"],
        "FORBIDDEN"
    );
}

#[tokio::test]
async fn failed_team_effects_leave_approvals_unspent_and_receipts_unpublished() {
    let f = Fixture::new().await;
    let (gateway, run, team) = ready(&f).await;
    let second = forge_store::teams::create(&f.database, &f.actor, &team_input(1))
        .await
        .unwrap();
    let input = call(
        "teams.update",
        json!({"slug":team.slug,"settings":{"description":"No approval"}}),
    );
    assert_eq!(
        gateway.invoke(&f.actor, input.clone(), run.id).await["errorCode"],
        "IDEMPOTENCY_KEY_REQUIRED"
    );
    let mut input = input;
    input["idempotencyKey"] = json!(Uuid::new_v4());
    assert_eq!(
        gateway.invoke(&f.actor, input, run.id).await["errorCode"],
        "APPROVAL_NOT_FOUND"
    );
    let invocation = approved(
        &f,
        run.id,
        &team.slug,
        json!({"identifier":second.identifier}),
    )
    .await;
    assert_eq!(
        gateway.invoke(&f.actor, invocation.clone(), run.id).await["errorCode"],
        "CAPABILITY_EXECUTION_FAILED"
    );
    assert_eq!(state(&f, &invocation).await, ApprovalState::Approved);
    assert_eq!(counts(&f).await, (0, 0, 0));
    forge_store::teams::update(
        &f.database,
        &f.actor,
        &forge_store::teams::Selector::Id(second.id),
        &forge_core::teams::TeamSettings::parse(json!({"identifier":"FREE"})).unwrap(),
    )
    .await
    .unwrap();
    let mut auto = invocation.clone();
    auto.as_object_mut().unwrap().remove("approvalId");
    assert_eq!(gateway.invoke(&f.actor, auto, run.id).await["ok"], true);
    assert_eq!(state(&f, &invocation).await, ApprovalState::Consumed);
    assert_eq!(counts(&f).await, (1, 1, 1));
}

#[tokio::test]
async fn capability_legacy_receipts_require_exact_hash_success_and_current_access() {
    let f = Fixture::new().await;
    let (gateway, run, team) = ready(&f).await;
    let invocation = approved(
        &f,
        run.id,
        &team.slug,
        json!({"description":"Legacy change"}),
    )
    .await;
    let mut a = approval(&f, run.id);
    a.id = invocation["approvalId"].as_str().unwrap().parse().unwrap();
    let mut old = super::invocation(&f, &a);
    old.idempotency_key = invocation["idempotencyKey"].as_str().unwrap().into();
    old.input_hash = forge_core::agents::approval::input_hash(&invocation["input"]);
    invocations::reserve(&f.database, &old).await.unwrap();
    assert_eq!(
        gateway.invoke(&f.actor, invocation.clone(), run.id).await["errorCode"],
        "IDEMPOTENCY_RECONCILIATION_REQUIRED"
    );
    invocations::complete(
        &f.database,
        old.id,
        json!({"ok":false,"errorCode":"FAILED","errorMessage":"Legacy failed"}),
        1,
    )
    .await
    .unwrap();
    assert_eq!(
        gateway.invoke(&f.actor, invocation.clone(), run.id).await["errorCode"],
        "IDEMPOTENCY_RECONCILIATION_REQUIRED"
    );
    let mut saved = serde_json::to_value(&team).unwrap();
    saved["description"] = json!("Old saved response");
    invocations::complete(&f.database, old.id, json!({"ok":true,"value":saved}), 1)
        .await
        .unwrap();
    let replay = gateway.invoke(&f.actor, invocation.clone(), run.id).await;
    assert_eq!(replay["value"]["description"], "Old saved response");
    assert_eq!(replay["ok"], true);
    assert_eq!(counts(&f).await, (0, 0, 0));
    assert_eq!(state(&f, &invocation).await, ApprovalState::Approved);
    let mut changed = invocation.clone();
    changed["input"]["settings"]["description"] = json!("Changed");
    let conflict = gateway.invoke(&f.actor, changed, run.id).await;
    assert_eq!(conflict["errorCode"], "IDEMPOTENCY_KEY_CONFLICT");
    assert_eq!(
        conflict["errorMessage"],
        "The invocation key was used with different input."
    );
    let current = forge_store::teams::get(
        &f.database,
        &f.actor,
        &forge_store::teams::Selector::Id(team.id),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(current.description, team.description);
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        gateway.invoke(&f.actor, invocation, run.id).await["errorCode"],
        "FORBIDDEN"
    );
}

struct Artifacts {
    value: Value,
}
#[async_trait]
impl ArtifactCreator for Artifacts {
    async fn create(&self, _actor: &Actor, run: Uuid, input: Value) -> Result<Value, StoreError> {
        assert_eq!(input["encoding"], "utf8");
        let mut value = self.value.clone();
        value["runId"] = json!(run);
        Ok(value)
    }
}
#[tokio::test]
async fn artifact_capability_checks_projection_schema_and_inline_byte_limit() {
    let f = Fixture::new().await;
    let (gateway, run, _) = ready(&f).await;
    let input = call(
        "artifacts.create",
        json!({"name":"hello.txt","contentType":"text/plain","content":"hello"}),
    );
    assert_eq!(
        gateway.invoke(&f.actor, input.clone(), run.id).await["errorCode"],
        "CAPABILITY_EXECUTION_FAILED"
    );
    let value = json!({"id":Uuid::new_v4(),"runId":run.id,"kind":"file","name":"hello.txt","contentType":"text/plain","sizeBytes":5,"checksum":"a".repeat(64),"retentionExpiresAt":null,"deletedAt":null,"createdAt":"2026-11-01T12:00:00.000Z"});
    let wired = gateway.clone().with_artifacts(Arc::new(Artifacts {
        value: value.clone(),
    }));
    assert_eq!(
        wired.invoke(&f.actor, input.clone(), run.id).await,
        json!({"ok":true,"value":value})
    );
    let mut invalid = value.clone();
    invalid["storageReference"] = json!("private/blob");
    assert_eq!(
        gateway
            .clone()
            .with_artifacts(Arc::new(Artifacts { value: invalid }))
            .invoke(&f.actor, input.clone(), run.id)
            .await["errorCode"],
        "INVALID_CAPABILITY_INPUT"
    );
    let mut oversized = value;
    oversized["name"] = json!("🐈".repeat(8192));
    assert_eq!(
        gateway
            .with_artifacts(Arc::new(Artifacts { value: oversized }))
            .invoke(&f.actor, input, run.id)
            .await["errorCode"],
        "CAPABILITY_RESULT_TOO_LARGE"
    );
}

#[tokio::test]
async fn agent_commands_and_approval_requests_share_a_non_deadlocking_lock_order() {
    let f = Fixture::new().await;
    let (gateway, run, team) = ready(&f).await;
    let invocation = approved(
        &f,
        run.id,
        &team.slug,
        json!({"description":"Concurrent action"}),
    )
    .await;
    let service = Service::new(f.database.clone());
    let actor = actor(&f, run.id);
    let request = Request {
        approval_id: None,
        run_id: run.id,
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: Risk::ReversibleWrite,
        input: json!({"another":"action"}),
        redacted_input_summary: json!({"summary":"Another action"}),
        expires_at: None,
    };
    let (write, approval) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            gateway.invoke(&actor, invocation, run.id),
            service.request(&actor, &request)
        )
    })
    .await
    .expect("agent lock order must not deadlock");
    assert_eq!(write["ok"], true);
    assert!(approval.is_ok(), "{approval:?}");
    assert_eq!(counts(&f).await, (1, 1, 1));
}
