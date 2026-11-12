use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_core::{actor::LoopScope, issues::CreateIssue, loops::principal_id};
use forge_store::{
    issues::{self, IssueOptions},
    loops::Service,
};
use std::sync::Arc;

pub(super) struct Claimed {
    pub definition: Uuid,
    pub run: Uuid,
    pub agent_run: Uuid,
    pub actor: Actor,
}
pub(super) async fn claimed(f: &Fixture, team: Uuid, event: Value, broad: bool) -> Claimed {
    let s = loop_acceptance::service(f);
    let mut fields = loop_acceptance::fields();
    if broad {
        fields["teamAccess"] = json!("all-public-teams");
    }
    let definition = loop_acceptance::create(&s, &f.actor, team, fields).await;
    loop_acceptance::enable(&s, &f.actor, team, definition, 1).await;
    occurrence(f, definition, event).await
}
pub(super) async fn occurrence(f: &Fixture, definition: Uuid, event: Value) -> Claimed {
    let (run, thread, agent_run): (Uuid,Uuid,Uuid) = sqlx::query_as("INSERT INTO loop_runs(workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,started_at,lease_at) SELECT workspace_id,id,revision,$2,$2,$3,fields,$4,'running',clock_timestamp(),clock_timestamp() FROM team_loops WHERE id=$1 RETURNING id,thread_id,agent_run_id")
        .bind(definition).bind(Uuid::new_v4().to_string()).bind(event).bind(&f.actor.user_id).fetch_one(&f.pool).await.unwrap();
    let actor = Actor {
        user_id: principal_id(&definition.to_string()),
        workspace_id: f.actor.workspace_id.clone(),
        workspace_role: "owner".into(),
        authentication: Authentication::Loop {
            loop_id: definition.to_string(),
            run_id: run.to_string(),
        },
        scopes: None,
        loop_scope: None,
    };
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)")
        .bind(thread)
        .bind(&actor.workspace_id)
        .bind(&actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native',$4)").bind(agent_run).bind(thread).bind(&actor.user_id).bind(json!({"loopRunId":run})).execute(&f.pool).await.unwrap();
    Claimed {
        definition,
        run,
        agent_run,
        actor,
    }
}
pub(super) async fn current(f: &Fixture, actor: &Actor) -> Result<Actor, StoreError> {
    let mut tx = f.database.begin().await?;
    let result = current_actor(&mut tx, actor).await?;
    tx.commit().await?;
    Ok(result)
}
pub(super) fn callback(claim: &Claimed) -> Actor {
    Actor {
        authentication: Authentication::Agent {
            run_id: claim.agent_run.to_string(),
            token_id: Uuid::new_v4().to_string(),
        },
        ..claim.actor.clone()
    }
}
fn at(s: &Service, time: DateTime<Utc>) -> Service {
    let mut s = s.clone();
    s.now = Arc::new(move || time);
    s
}

#[tokio::test]
async fn loop_identity_rebuilds_scope_and_rejects_cross_run_principals_and_feature_revocation() {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 110).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    let c = claimed(&f, team, json!({"kind":"manual"}), false).await;
    let member_count: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE user_id=$1")
        .bind(&c.actor.user_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(member_count, 0);
    let resolved = current(&f, &c.actor).await.unwrap();
    assert_eq!(resolved.workspace_role, "member");
    assert_eq!(resolved.scopes.as_ref().unwrap().len(), 10);
    assert!(!resolved.has_scope(ApiScope::ModelConnectionsWrite));
    assert_eq!(
        resolved.loop_scope.as_ref().unwrap().team_id,
        team.to_string()
    );
    assert!(!resolved.loop_scope.as_ref().unwrap().all_public);
    let mut forged = c.actor.clone();
    forged.loop_scope = Some(LoopScope {
        loop_id: Uuid::new_v4().to_string(),
        run_id: Uuid::new_v4().to_string(),
        team_id: Uuid::new_v4().to_string(),
        all_public: true,
        cancelling: true,
    });
    forged.scopes = Some(vec![ApiScope::AgentsRead, ApiScope::ModelConnectionsWrite]);
    let narrowed = current(&f, &forged).await.unwrap();
    assert_eq!(narrowed.scopes, Some(vec![ApiScope::AgentsRead]));
    assert_eq!(narrowed.loop_scope, resolved.loop_scope);
    for bad in [
        Actor {
            user_id: f.actor.user_id.clone(),
            ..c.actor.clone()
        },
        Actor {
            workspace_id: Uuid::new_v4().to_string(),
            ..c.actor.clone()
        },
        Actor {
            authentication: Authentication::Loop {
                loop_id: Uuid::new_v4().to_string(),
                run_id: c.run.to_string(),
            },
            ..c.actor.clone()
        },
    ] {
        assert!(matches!(
            current(&f, &bad).await,
            Err(StoreError::Forbidden)
        ));
    }
    let mut s = loop_acceptance::service(&f);
    s.options.enabled = false;
    assert!(matches!(
        s.authorize_actor(&c.actor).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE team_loops SET enabled=false WHERE id=$1")
        .bind(c.definition)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        current(&f, &resolved).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn source_authority_intersects_captured_and_current_scope_and_live_team_visibility() {
    let f = Fixture::new().await;
    let own = issue_acceptance::team(&f, 111).await;
    let other = issue_acceptance::team(&f, 112).await;
    let issue = issue_acceptance::create(&f, other, "Live source").await;
    let c = claimed(
        &f,
        own,
        json!({"kind":"event","entity":"issue","entityId":issue["id"],"event":"created"}),
        true,
    )
    .await;
    assert!(
        current(&f, &callback(&c))
            .await
            .unwrap()
            .loop_scope
            .unwrap()
            .all_public
    );
    sqlx::query(
        "UPDATE team_loops SET fields=jsonb_set(fields,'{teamAccess}','\"this-team\"') WHERE id=$1",
    )
    .bind(c.definition)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(matches!(
        current(&f, &callback(&c)).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE team_loops SET fields=jsonb_set(fields,'{teamAccess}','\"all-public-teams\"') WHERE id=$1").bind(c.definition).execute(&f.pool).await.unwrap();
    sqlx::query(
        "UPDATE loop_runs SET fields=jsonb_set(fields,'{teamAccess}','\"this-team\"') WHERE id=$1",
    )
    .bind(c.run)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(matches!(
        current(&f, &c.actor).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE loop_runs SET fields=jsonb_set(fields,'{teamAccess}','\"all-public-teams\"') WHERE id=$1").bind(c.run).execute(&f.pool).await.unwrap();
    for team in [own, other] {
        sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
            .bind(team)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(matches!(
            current(&f, &c.actor).await,
            Err(StoreError::Forbidden)
        ));
        sqlx::query("UPDATE teams SET visibility='workspace' WHERE id=$1")
            .bind(team)
            .execute(&f.pool)
            .await
            .unwrap();
    }
    assert!(current(&f, &c.actor).await.is_ok());
    sqlx::query("UPDATE issues SET deleted_at=clock_timestamp() WHERE id::text=$1")
        .bind(issue["id"].as_str().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        current(&f, &callback(&c)).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn original_deadline_and_cancellation_exceptions_cannot_be_extended_by_callbacks() {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 113).await;
    let c = claimed(&f, team, json!({"kind":"webhook"}), false).await;
    let s = loop_acceptance::service(&f);
    let start: DateTime<Utc> = sqlx::query_scalar("SELECT started_at FROM loop_runs WHERE id=$1")
        .bind(c.run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.authorize_actor(&c.actor).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,external_loop_sources_enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET external_loop_sources_enabled=true").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let live = at(&s, start + Duration::milliseconds(239999))
        .authorize_actor(&c.actor)
        .await
        .unwrap();
    sqlx::query("UPDATE loop_runs SET lease_at=started_at+interval '3 minutes' WHERE id=$1")
        .bind(c.run)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        at(&s, start + Duration::minutes(4))
            .authorize_actor(&c.actor)
            .await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE loop_runs SET pending_decision=$2 WHERE id=$1")
        .bind(c.run)
        .bind(json!({"action":"cancel-run"}))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.authorize_actor(&c.actor).await,
        Err(StoreError::Forbidden)
    ));
    let mut cancelling = live;
    cancelling.loop_scope.as_mut().unwrap().cancelling = true;
    sqlx::query("UPDATE team_loops SET enabled=false,deleted_at=clock_timestamp() WHERE id=$1")
        .bind(c.definition)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workspace_security_settings SET external_loop_sources_enabled=false WHERE workspace_id=$1").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        at(&s, start + Duration::hours(1))
            .authorize_actor(&cancelling)
            .await
            .unwrap()
            .scopes,
        Some(vec![ApiScope::AgentsRead, ApiScope::AgentsWrite])
    );
    let mut agent = callback(&c);
    agent.loop_scope = cancelling.loop_scope.clone();
    assert!(matches!(
        current(&f, &agent).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE loop_runs SET state='cancelled' WHERE id=$1")
        .bind(c.run)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.authorize_actor(&cancelling).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn callbacks_require_exact_captured_run_and_cannot_reconnect_or_borrow_approvals() {
    use forge_store::agents::approval_service::{Request, Service};
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 114).await;
    let c = claimed(&f, team, json!({"kind":"manual"}), false).await;
    let other = occurrence(&f, c.definition, json!({"kind":"manual"})).await;
    assert!(current(&f, &callback(&c)).await.is_ok());
    sqlx::query("UPDATE agent_runs SET requested_selection=$2 WHERE id=$1")
        .bind(c.agent_run)
        .bind(json!({"loopRunId":other.run}))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        current(&f, &callback(&c)).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE agent_runs SET requested_selection=$2,state='reconnecting' WHERE id=$1")
        .bind(c.agent_run)
        .bind(json!({"loopRunId":c.run}))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        current(&f, &callback(&c)).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE agent_runs SET state='running' WHERE id=$1")
        .bind(c.agent_run)
        .execute(&f.pool)
        .await
        .unwrap();
    let approval = Service::new(f.database.clone());
    let request = |run| Request {
        approval_id: Some(Uuid::new_v4()),
        run_id: run,
        capability_id: "teams.update".into(),
        capability_version: "1".into(),
        risk: forge_store::agents::Risk::ReversibleWrite,
        input: json!({"slug":"fixture"}),
        redacted_input_summary: json!({"summary":"Update"}),
        expires_at: None,
    };
    assert!(
        approval
            .request(&c.actor, &request(other.agent_run))
            .await
            .is_err()
    );
    let own = approval
        .request(&c.actor, &request(c.agent_run))
        .await
        .unwrap();
    assert_eq!(own.approval.run_id, c.agent_run);
    assert_eq!(own.approval.requested_for_user_id, c.actor.user_id);
}

#[tokio::test]
async fn loop_commands_suppress_recursive_capture_and_revalidate_receipt_replay() {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 115).await;
    let c = claimed(&f, team, json!({"kind":"manual"}), false).await;
    let count = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM loop_events WHERE workspace_id=$1 AND entity='issue'",
        )
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
    };
    let before = count().await;
    let input =
        CreateIssue::parse(issue_acceptance::create_input(team, "Loop-created issue")).unwrap();
    let first = issues::create(&f.database, &c.actor, &input, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(count().await, before);
    let replay = issues::create(&f.database, &c.actor, &input, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(first["issue"], replay["issue"]);
    assert_eq!(replay["replayed"], true);
    issue_acceptance::create(&f, team, "Human-created issue").await;
    assert_eq!(count().await, before + 1);
    sqlx::query("UPDATE team_loops SET enabled=false WHERE id=$1")
        .bind(c.definition)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        issues::create(&f.database, &c.actor, &input, IssueOptions::default()).await,
        Err(StoreError::Forbidden)
    ));
}
