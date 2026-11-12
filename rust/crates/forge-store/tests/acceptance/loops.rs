use super::{Fixture, enter_workspace, issue_acceptance, team_input};
use forge_core::actor::Actor;
use forge_store::{
    StoreError,
    loops::{Options, Service},
    teams,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;
fn options() -> Options {
    Options::from_environment(HashMap::from([
        ("NODE_ENV".into(), "test".into()),
        ("FORGE_LOOPS_ENABLED".into(), "true".into()),
        ("AGENT_FAKE_RUNTIME_ENABLED".into(), "true".into()),
        (
            "FORGE_LOOP_WEBHOOK_SECRET".into(),
            "local-loop-fixture-secret-at-least-32".into(),
        ),
    ]))
}
pub(super) fn service(f: &Fixture) -> Service {
    Service::new(f.database.clone(), options())
}
pub(super) fn fields() -> Value {
    json!({"name":"Investigate","description":"","instructions":"Inspect this issue.","trigger":{"kind":"event","entity":"issue","event":"created"},"conditions":[],"reasoning":"auto","teamAccess":"this-team"})
}
async fn call(s: &Service, a: &Actor, team: Uuid, input: Value) -> Value {
    s.command(a, &team.to_string(), &Uuid::new_v4().to_string(), input)
        .await
        .unwrap()
}
pub(super) async fn create(s: &Service, a: &Actor, team: Uuid, fields: Value) -> Uuid {
    let id = Uuid::new_v4();
    assert_eq!(
        call(
            s,
            a,
            team,
            json!({"action":"create","id":id,"fields":fields})
        )
        .await["status"],
        "saved"
    );
    id
}
pub(super) async fn enable(s: &Service, a: &Actor, team: Uuid, id: Uuid, revision: i32) -> Value {
    call(
        s,
        a,
        team,
        json!({"action":"enable","id":id,"expectedRevision":revision}),
    )
    .await
}
async fn external(f: &Fixture, enabled: bool) {
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,external_loop_sources_enabled) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET external_loop_sources_enabled=$2").bind(&f.actor.workspace_id).bind(enabled).execute(&f.pool).await.unwrap();
}
#[tokio::test]
async fn loop_commands_serialize_retries_revisions_and_publication_history() {
    let f = Fixture::new().await;
    let s = service(&f);
    let team = teams::create(&f.database, &f.actor, &team_input(81))
        .await
        .unwrap()
        .id;
    let id = Uuid::new_v4();
    let key = Uuid::new_v4().to_string();
    let team_id = team.to_string();
    let input = json!({"action":"create","id":id,"fields":fields()});
    let (a, b) = tokio::join!(
        s.command(&f.actor, &team_id, &key, input.clone()),
        s.command(&f.actor, &team_id, &key, input.clone())
    );
    assert_eq!(a.unwrap(), b.unwrap());
    let counts:(i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM team_loops WHERE workspace_id=$1),(SELECT count(*) FROM loop_revisions WHERE workspace_id=$1),(SELECT count(*) FROM command_receipts WHERE workspace_id=$1 AND operation='loops.write@1'),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='loop.create')").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1, 1));
    let mut edit = json!({"action":"save","id":id,"expectedRevision":1,"fields":fields()});
    edit["fields"]["name"] = json!("First save");
    let mut other = edit.clone();
    other["fields"]["name"] = json!("Second save");
    let (a, b) = tokio::join!(
        call(&s, &f.actor, team, edit.clone()),
        call(&s, &f.actor, team, other)
    );
    assert_eq!(
        usize::from(a["status"] == "saved") + usize::from(b["status"] == "saved"),
        1
    );
    let conflict = if a["status"] == "conflict" { a } else { b };
    assert_eq!(conflict["current"]["revision"], 2);
    let directory = s.read(&f.actor, &team_id).await.unwrap();
    assert_eq!(directory["versions"].as_array().unwrap().len(), 2);
    assert_eq!(directory["loops"][0]["enabled"], false);
    let mut changed = input;
    changed["fields"]["name"] = json!("Changed retry");
    assert!(matches!(
        s.command(&f.actor, &team_id, &key, changed).await,
        Err(StoreError::CommandReused)
    ));
    let deletion = json!({"action":"delete","id":id,"expectedRevision":2});
    let delete_key = Uuid::new_v4().to_string();
    let first = s
        .command(&f.actor, &team_id, &delete_key, deletion.clone())
        .await
        .unwrap();
    assert_eq!(
        s.command(&f.actor, &team_id, &delete_key, deletion)
            .await
            .unwrap(),
        first
    );
    assert_eq!(
        s.read(&f.actor, &team_id).await.unwrap()["loops"],
        json!([])
    );
}
#[tokio::test]
async fn loop_management_rechecks_live_role_feature_team_and_session_authority() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = teams::create(&f.database, &f.actor, &team_input(82))
        .await
        .unwrap()
        .id;
    let mut s = service(&f);
    let input = json!({"action":"create","id":Uuid::new_v4(),"fields":fields()});
    let key = Uuid::new_v4().to_string();
    let team_id = team.to_string();
    assert!(matches!(
        s.command(&member, &team_id, &key, input.clone()).await,
        Err(StoreError::Forbidden)
    ));
    s.command(&f.actor, &team_id, &key, input.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.command(&f.actor, &team_id, &key, input.clone()).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.read(&member, &team_id).await,
        Err(StoreError::Forbidden)
    ));
    s.options.enabled = false;
    assert_eq!(
        s.read(&member, &team_id).await.unwrap(),
        json!({"enabled":false,"loops":[],"runs":[]})
    );
    assert!(s.command(&f.actor, &team_id, &key, input).await.is_err());
}
#[tokio::test]
async fn private_loops_cannot_expand_and_capacity_is_serialized() {
    let f = Fixture::new().await;
    let s = service(&f);
    let team = teams::create(&f.database, &f.actor, &team_input(83))
        .await
        .unwrap()
        .id;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut p = fields();
    p["teamAccess"] = json!("all-public-teams");
    assert!(matches!(
        s.command(
            &f.actor,
            &team.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"create","id":Uuid::new_v4(),"fields":p})
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("INSERT INTO team_loops(workspace_id,team_id,fields) SELECT $1,$2,$3 FROM generate_series(1,99)").bind(&f.actor.workspace_id).bind(team).bind(fields()).execute(&f.pool).await.unwrap();
    let a = json!({"action":"create","id":Uuid::new_v4(),"fields":fields()});
    let b = json!({"action":"create","id":Uuid::new_v4(),"fields":fields()});
    let team_id = team.to_string();
    let ka = Uuid::new_v4().to_string();
    let kb = Uuid::new_v4().to_string();
    let (a, b) = tokio::join!(
        s.command(&f.actor, &team_id, &ka, a),
        s.command(&f.actor, &team_id, &kb, b)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(
        a.err().or(b.err()),
        Some(StoreError::LoopPolicy("A team can have up to 100 Loops."))
    ));
}
#[tokio::test]
async fn loop_schedules_preserve_anchors_and_enable_replay_rechecks_runtime_flags() {
    let f = Fixture::new().await;
    let mut s = service(&f);
    let now: chrono::DateTime<chrono::Utc> = "2026-03-28T12:00:00Z".parse().unwrap();
    s.now = std::sync::Arc::new(move || now);
    let team = teams::create(&f.database, &f.actor, &team_input(84))
        .await
        .unwrap()
        .id;
    let mut p = fields();
    p["trigger"] = json!({"kind":"schedule","unit":"days","interval":1,"startAt":"2020-01-01T12:00:00.000Z","timeZone":"Europe/Paris"});
    let mut weekly = p.clone();
    weekly["trigger"]["unit"] = json!("weeks");
    weekly["trigger"]["weekdays"] = json!([1]);
    weekly["trigger"]["interval"] = json!(1000);
    for past in [p.clone(), weekly] {
        let result = s
            .command(
                &f.actor,
                &team.to_string(),
                &Uuid::new_v4().to_string(),
                json!({"action":"create","id":Uuid::new_v4(),"fields":past}),
            )
            .await;
        assert!(
            matches!(
                result,
                Err(StoreError::LoopPolicy(
                    "Choose a first run in the future for a new schedule."
                ))
            ),
            "{result:?}"
        );
    }
    p["trigger"]["startAt"] = json!(forge_core::loops::iso_timestamp(
        now + chrono::Duration::days(2)
    ));
    let id = create(&s, &f.actor, team, p.clone()).await;
    let key = Uuid::new_v4().to_string();
    let enabled = json!({"action":"enable","id":id,"expectedRevision":1});
    s.command(&f.actor, &team.to_string(), &key, enabled.clone())
        .await
        .unwrap();
    let next: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT next_run_at FROM team_loops WHERE id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(
        forge_core::loops::iso_timestamp(next),
        p["trigger"]["startAt"]
    );
    s.now = std::sync::Arc::new(move || now + chrono::Duration::days(3));
    assert_eq!(
        call(
            &s,
            &f.actor,
            team,
            json!({"action":"save","id":id,"expectedRevision":2,"fields":p})
        )
        .await["status"],
        "saved"
    );
    s.options
        .environment
        .insert("FORGE_FEATURE_AGENT_UI".into(), "false".into());
    assert!(matches!(
        s.command(&f.actor, &team.to_string(), &key, enabled).await,
        Err(StoreError::LoopPolicy(
            "Cloud agent execution is disabled in this environment."
        ))
    ));
}
#[tokio::test]
async fn manual_runs_capture_revisions_bind_current_sources_and_cancel_without_duplicates() {
    let f = Fixture::new().await;
    let s = service(&f);
    let team = teams::create(&f.database, &f.actor, &team_input(85))
        .await
        .unwrap()
        .id;
    let issue = issue_acceptance::create(&f, team, "Current source").await;
    let id = create(&s, &f.actor, team, fields()).await;
    let input = json!({"action":"run-now","id":id,"expectedRevision":1,"entityId":issue["id"]});
    assert!(
        s.command(
            &f.actor,
            &team.to_string(),
            &Uuid::new_v4().to_string(),
            input
        )
        .await
        .is_err()
    );
    enable(&s, &f.actor, team, id, 1).await;
    let key = Uuid::new_v4().to_string();
    let input = json!({"action":"run-now","id":id,"expectedRevision":2,"entityId":issue["id"]});
    let first = s
        .command(&f.actor, &team.to_string(), &key, input.clone())
        .await
        .unwrap();
    assert_eq!(
        s.command(&f.actor, &team.to_string(), &key, input)
            .await
            .unwrap(),
        first
    );
    let (run, event, revision): (Uuid, Value, i32) =
        sqlx::query_as("SELECT id,event,loop_revision FROM loop_runs WHERE loop_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(revision, 2);
    assert_eq!(event["context"]["title"], "Current source");
    let mut p = fields();
    p["instructions"] = json!("New instructions");
    call(
        &s,
        &f.actor,
        team,
        json!({"action":"save","id":id,"expectedRevision":2,"fields":p}),
    )
    .await;
    let captured: Value = sqlx::query_scalar("SELECT fields FROM loop_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(captured["instructions"], fields()["instructions"]);
    call(
        &s,
        &f.actor,
        team,
        json!({"action":"cancel-run","id":id,"expectedRevision":3,"runId":run}),
    )
    .await;
    let state: String = sqlx::query_scalar("SELECT state FROM loop_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(state, "cancelled");
    call(
        &s,
        &f.actor,
        team,
        json!({"action":"run-now","id":id,"expectedRevision":3,"entityId":issue["id"]}),
    )
    .await;
    sqlx::query("UPDATE loop_runs SET state='running' WHERE loop_id=$1 AND state='queued'")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    call(
        &s,
        &f.actor,
        team,
        json!({"action":"disable","id":id,"expectedRevision":3}),
    )
    .await;
    let pending: Value = sqlx::query_scalar(
        "SELECT pending_decision FROM loop_runs WHERE loop_id=$1 AND state='running'",
    )
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(pending, json!({"action":"cancel-run"}));
}
#[tokio::test]
async fn webhook_secrets_replay_exactly_rotate_generations_and_recheck_external_policy() {
    let f = Fixture::new().await;
    let s = service(&f);
    let team = teams::create(&f.database, &f.actor, &team_input(86))
        .await
        .unwrap()
        .id;
    let mut p = fields();
    p["trigger"] = json!({"kind":"webhook"});
    let id = create(&s, &f.actor, team, p).await;
    let key = Uuid::new_v4().to_string();
    let input = json!({"action":"rotate-webhook","id":id,"expectedRevision":1});
    let secret = s
        .command(&f.actor, &team.to_string(), &key, input.clone())
        .await
        .unwrap();
    assert_eq!(
        s.command(&f.actor, &team.to_string(), &key, input)
            .await
            .unwrap(),
        secret
    );
    let token = secret["webhookSecret"].as_str().unwrap();
    let receipt: String = sqlx::query_scalar(
        "SELECT response_body FROM command_receipts WHERE workspace_id=$1 AND command_key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(key)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!receipt.contains(token));
    assert!(matches!(
        s.command(
            &f.actor,
            &team.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"enable","id":id,"expectedRevision":2})
        )
        .await,
        Err(StoreError::LoopPolicy(_))
    ));
    external(&f, true).await;
    enable(&s, &f.actor, team, id, 2).await;
    let payload = json!({"event":"deploy","count":1});
    let id_text = id.to_string();
    let (a, b) = tokio::join!(
        s.webhook(&id_text, token, "event-1", payload.clone()),
        s.webhook(&id_text, token, "event-1", payload.clone())
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert!(matches!(
        s.webhook(
            &id.to_string(),
            token,
            "event-1",
            json!({"event":"changed"})
        )
        .await,
        Err(StoreError::LoopPolicy(_))
    ));
    external(&f, false).await;
    assert_eq!(
        s.webhook(&id.to_string(), token, "event-1", payload.clone())
            .await
            .unwrap(),
        None
    );
    external(&f, true).await;
    let next = call(
        &s,
        &f.actor,
        team,
        json!({"action":"rotate-webhook","id":id,"expectedRevision":3}),
    )
    .await;
    let next = next["webhookSecret"].as_str().unwrap();
    assert_ne!(next, token);
    let numeric = s
        .webhook(
            &id.to_string(),
            next,
            "large-number",
            json!({"value":9007199254740993u64}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        s.webhook(
            &id.to_string(),
            next,
            "large-number",
            json!({"value":9007199254740992u64})
        )
        .await
        .unwrap(),
        Some(numeric)
    );
    let captured: Value =
        sqlx::query_scalar("SELECT event->'payload'->'value' FROM loop_runs WHERE id=$1")
            .bind(numeric)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(captured, json!(9007199254740992u64));
    assert_eq!(
        s.webhook(&id.to_string(), token, "event-2", payload.clone())
            .await
            .unwrap(),
        None
    );
    assert!(
        s.webhook(&id.to_string(), next, "event-1", payload)
            .await
            .unwrap()
            .is_some()
    );
}
#[tokio::test]
async fn loop_history_rechecks_activity_and_approval_decisions_keep_exact_run_binding() {
    let f = Fixture::new().await;
    let s = service(&f);
    let team = teams::create(&f.database, &f.actor, &team_input(87))
        .await
        .unwrap()
        .id;
    let issue = issue_acceptance::create(&f, team, "Activity source").await;
    let issue_id: Uuid = issue["id"].as_str().unwrap().parse().unwrap();
    sqlx::query("UPDATE issues SET properties=properties||$2 WHERE id=$1")
        .bind(issue_id)
        .bind(json!({"comments":[{"id":"comment-1","body":"Review this"}]}))
        .execute(&f.pool)
        .await
        .unwrap();
    let id = create(&s, &f.actor, team, fields()).await;
    enable(&s, &f.actor, team, id, 1).await;
    call(
        &s,
        &f.actor,
        team,
        json!({"action":"run-now","id":id,"expectedRevision":2,"entityId":issue_id}),
    )
    .await;
    let (run, thread, agent): (Uuid, Uuid, Uuid) =
        sqlx::query_as("SELECT id,thread_id,agent_run_id FROM loop_runs WHERE loop_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let principal = forge_core::loops::principal_id(&id.to_string());
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)")
        .bind(thread)
        .bind(&f.actor.workspace_id)
        .bind(&principal)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'waiting-for-approval','forge-native',$4)").bind(agent).bind(thread).bind(&principal).bind(json!({"loopRunId":run})).execute(&f.pool).await.unwrap();
    let approval = Uuid::new_v4();
    let hash = "a".repeat(64);
    sqlx::query("INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,nonce,expires_at) VALUES($1,$2,$3,$4,'issues.update','reversible-write',$5,'{}',$6,clock_timestamp()+interval '1 hour')").bind(approval).bind(&f.actor.workspace_id).bind(agent).bind(&principal).bind(&hash).bind(Uuid::new_v4().to_string()).execute(&f.pool).await.unwrap();
    sqlx::query("UPDATE loop_runs SET state='waiting-for-approval',started_at=clock_timestamp(),result='Visible result',event=event||$2 WHERE id=$1").bind(run).bind(json!({"comment":{"id":"comment-1","text":"Review this","mentionIds":[]}})).execute(&f.pool).await.unwrap();
    let history = s.read(&f.actor, &team.to_string()).await.unwrap();
    assert_eq!(history["runs"][0]["result"], "Visible result");
    assert_eq!(
        history["runs"][0]["approvals"][0]["summary"],
        "Review this tool action"
    );
    let mut decision = json!({"action":"approve","id":id,"expectedRevision":2,"runId":run,"approvalId":approval,"inputHash":"b".repeat(64)});
    assert!(matches!(
        s.command(
            &f.actor,
            &team.to_string(),
            &Uuid::new_v4().to_string(),
            decision.clone()
        )
        .await,
        Err(StoreError::LoopPolicy(_))
    ));
    decision["inputHash"] = json!(hash);
    call(&s, &f.actor, team, decision.clone()).await;
    let (pending,state):(Value,String)=sqlx::query_as("SELECT r.pending_decision,a.state FROM loop_runs r JOIN agent_approvals a ON a.run_id=r.agent_run_id WHERE r.id=$1").bind(run).fetch_one(&f.pool).await.unwrap();
    assert_eq!(pending["requestedById"], f.actor.user_id);
    assert_eq!(state, "pending");
    assert!(
        s.command(
            &f.actor,
            &team.to_string(),
            &Uuid::new_v4().to_string(),
            decision.clone()
        )
        .await
        .is_err()
    );
    sqlx::query("UPDATE loop_runs SET pending_decision=NULL WHERE id=$1")
        .bind(run)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(approval)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(
        s.command(
            &f.actor,
            &team.to_string(),
            &Uuid::new_v4().to_string(),
            decision
        )
        .await
        .is_err()
    );
    sqlx::query("UPDATE issues SET properties=jsonb_set(properties,'{comments,0,body}','\"Edited\"') WHERE id=$1").bind(issue_id).execute(&f.pool).await.unwrap();
    let hidden = s.read(&f.actor, &team.to_string()).await.unwrap();
    let hidden = &hidden["runs"][0];
    assert_eq!(hidden["errorCode"], "SOURCE_UNAVAILABLE");
    assert!(hidden["threadId"].is_null());
    assert!(hidden["result"].is_null());
    assert_eq!(hidden["approvals"], json!([]));
}
#[tokio::test]
async fn loop_history_intersects_current_and_captured_team_scope() {
    let f = Fixture::new().await;
    let s = service(&f);
    let own = teams::create(&f.database, &f.actor, &team_input(88))
        .await
        .unwrap()
        .id;
    let other = teams::create(&f.database, &f.actor, &team_input(89))
        .await
        .unwrap()
        .id;
    let issue = issue_acceptance::create(&f, other, "Other public source").await;
    let mut p = fields();
    p["teamAccess"] = json!("all-public-teams");
    let id = create(&s, &f.actor, own, p.clone()).await;
    enable(&s, &f.actor, own, id, 1).await;
    call(
        &s,
        &f.actor,
        own,
        json!({"action":"run-now","id":id,"expectedRevision":2,"entityId":issue["id"]}),
    )
    .await;
    sqlx::query("UPDATE loop_runs SET started_at=clock_timestamp(),result='Cross-team result' WHERE loop_id=$1").bind(id).execute(&f.pool).await.unwrap();
    assert_eq!(
        s.read(&f.actor, &own.to_string()).await.unwrap()["runs"][0]["result"],
        "Cross-team result"
    );
    p["teamAccess"] = json!("this-team");
    call(
        &s,
        &f.actor,
        own,
        json!({"action":"save","id":id,"expectedRevision":2,"fields":p}),
    )
    .await;
    assert_eq!(
        s.read(&f.actor, &own.to_string()).await.unwrap()["runs"][0]["errorCode"],
        "SOURCE_UNAVAILABLE"
    );
    assert!(
        s.command(
            &f.actor,
            &own.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"run-now","id":id,"expectedRevision":3,"entityId":issue["id"]})
        )
        .await
        .is_err()
    );
}
