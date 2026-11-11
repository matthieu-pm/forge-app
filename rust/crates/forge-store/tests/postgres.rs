use async_trait::async_trait;
use forge_core::actor::{Actor, ApiScope, Authentication};
use forge_store::{
    StoreError,
    authority::{api_key_actor, api_key_hash, current_actor, session_actor},
    commands::{Command, CommandHandler, CommandResult, OutboxEvent, execute},
};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[path = "acceptance/definitions.rs"]
mod definition_acceptance;
#[path = "acceptance/documents.rs"]
mod document_acceptance;
#[path = "acceptance/files.rs"]
mod file_acceptance;
#[path = "acceptance/imports.rs"]
mod import_acceptance;
#[path = "acceptance/initiatives.rs"]
mod initiative_acceptance;
#[path = "acceptance/issues.rs"]
mod issue_acceptance;
#[path = "acceptance/issue_lifecycle.rs"]
mod issue_lifecycle_acceptance;
#[path = "acceptance/issue_queries.rs"]
mod issue_query_acceptance;
#[path = "acceptance/jobs.rs"]
mod job_acceptance;
#[path = "acceptance/planning.rs"]
mod planning_acceptance;
#[path = "acceptance/product_state.rs"]
mod product_state_acceptance;
#[path = "acceptance/projects.rs"]
mod project_acceptance;
#[path = "acceptance/views.rs"]
mod view_acceptance;

fn team_input(n: u32) -> forge_core::teams::CreateTeam {
    forge_core::teams::CreateTeam::parse(json!({"name":format!("Team {n}"),"identifier":format!("T{n}"),"icon":{"kind":"icon","value":"UserGroup03Icon","color":"#818cf8"},"timezone":"Europe/Paris"})).unwrap()
}
async fn team_key(f: &Fixture) -> Actor {
    let created = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Team API".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::TeamsRead, ApiScope::TeamsWrite],
        },
    )
    .await
    .unwrap();
    api_key_actor(&f.database, created["key"].as_str().unwrap())
        .await
        .unwrap()
}
async fn enter_workspace(f: &Fixture, visitor: &Fixture) -> Actor {
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')")
        .bind(Uuid::new_v4().to_string())
        .bind(&f.actor.workspace_id)
        .bind(&visitor.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    forge_store::workspaces::set_active(
        &visitor.database,
        &visitor.token,
        Some(&f.actor.workspace_id),
    )
    .await
    .unwrap();
    session_actor(&visitor.database, &visitor.token)
        .await
        .unwrap()
}

#[tokio::test]
async fn concurrent_team_admission_preserves_capacity_memberships_and_seeded_statuses() {
    use forge_store::teams;
    let f = Fixture::new().await;
    teams::create(&f.database, &f.actor, &team_input(0))
        .await
        .unwrap();
    let a = team_input(1);
    let b = team_input(2);
    let (first, second) = tokio::join!(
        teams::create(&f.database, &f.actor, &a),
        teams::create(&f.database, &f.actor, &b)
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(
        matches!(
            first,
            Err(StoreError::Team(forge_core::teams::TeamError::TeamLimit))
        ) || matches!(
            second,
            Err(StoreError::Team(forge_core::teams::TeamError::TeamLimit))
        )
    );
    let counts:(i64,i64,i64,i32)=sqlx::query_as("SELECT (SELECT count(*) FROM teams WHERE workspace_id=$1),(SELECT count(*) FROM team_members WHERE workspace_id=$1),(SELECT count(*) FROM issue_statuses WHERE workspace_id=$1),(SELECT active_team_count FROM workspace_team_capacity WHERE workspace_id=$1)").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (2, 2, 14, 2));
    let statuses:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'group',status_group,'description',description,'color',color) FROM issue_statuses WHERE workspace_id=$1 AND team_id=(SELECT id FROM teams WHERE workspace_id=$1 ORDER BY name LIMIT 1) ORDER BY position").bind(&f.actor.workspace_id).fetch_all(&f.pool).await.unwrap();
    let defaults: Value =
        serde_json::from_str(include_str!("../../forge-core/data/issue-definitions.json")).unwrap();
    assert_eq!(json!(statuses), defaults["statuses"]["statuses"]);
}

#[tokio::test]
async fn team_receipts_replay_once_and_recheck_policy_and_archived_visibility() {
    use forge_store::teams::{self, Selector};
    let f = Fixture::new().await;
    let actor = team_key(&f).await;
    let input = team_input(1);
    let (a, b) = tokio::join!(
        teams::create_idempotent(&f.database, &actor, &input, "same-team"),
        teams::create_idempotent(&f.database, &actor, &input, "same-team")
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.value.id, b.value.id);
    assert_ne!(a.replayed, b.replayed);
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM teams WHERE workspace_id=$1),(SELECT count(*) FROM command_audit_events WHERE workspace_id=$1),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1)").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    assert!(matches!(
        teams::create_idempotent(&f.database, &actor, &team_input(2), "same-team").await,
        Err(StoreError::CommandReused)
    ));
    teams::archive(&f.database, &f.actor, &Selector::Id(a.value.id), None)
        .await
        .unwrap();
    assert!(matches!(
        teams::create_idempotent(&f.database, &actor, &input, "same-team").await,
        Err(StoreError::Forbidden)
    ));
    teams::restore(&f.database, &f.actor, &Selector::Id(a.value.id))
        .await
        .unwrap();
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        teams::create_idempotent(&f.database, &actor, &input, "same-team").await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn legacy_team_receipts_remain_evidence_even_after_expiry_without_new_history() {
    use forge_store::teams;
    use sha2::{Digest, Sha256};
    let f = Fixture::new().await;
    let actor = team_key(&f).await;
    let input = team_input(1);
    let team = teams::create(&f.database, &f.actor, &input).await.unwrap();
    let Authentication::ApiKey { credential_id } = &actor.authentication else {
        unreachable!()
    };
    let input_json = serde_json::to_value(&input).unwrap();
    let hash = format!(
        "{:x}",
        Sha256::digest(forge_core::canonical::javascript_stringify(&input_json).as_bytes())
    );
    sqlx::query("INSERT INTO api_idempotency_keys(workspace_id,credential_id,operation_id,idempotency_key,request_hash,response_body,response_status,expires_at) VALUES($1,$2,'createTeam','legacy',$3,$4,201,now()-interval '1 day')").bind(&f.actor.workspace_id).bind(credential_id).bind(&hash).bind(serde_json::to_string(&team).unwrap()).execute(&f.pool).await.unwrap();
    let replay = teams::create_idempotent(&f.database, &actor, &input, "legacy")
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.value.id, team.id);
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM command_receipts WHERE workspace_id=$1),(SELECT count(*) FROM command_audit_events WHERE workspace_id=$1),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1)").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (0, 0, 0));
    assert!(matches!(
        teams::create_idempotent(&f.database, &actor, &team_input(2), "legacy").await,
        Err(StoreError::CommandReused)
    ));
    sqlx::query("UPDATE api_idempotency_keys SET response_body=NULL WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        teams::create_idempotent(&f.database, &actor, &input, "legacy").await,
        Err(StoreError::CommandAmbiguous)
    ));
}

#[tokio::test]
async fn team_archiving_restoration_and_identifier_reuse_preserve_existing_data() {
    use forge_core::teams::TeamError;
    use forge_store::teams::{self, Selector};
    let f = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(1))
        .await
        .unwrap();
    let selector = Selector::Id(team.id);
    assert!(matches!(
        teams::archive(&f.database, &f.actor, &selector, Some("wrong name")).await,
        Err(StoreError::Team(TeamError::ConfirmationMismatch))
    ));
    let settings=forge_core::teams::TeamSettings::parse(json!({"name":"Renamed team","identifier":"new","estimationScheme":"fibonacci","detailedHistoryEnabled":true})).unwrap();
    let renamed = teams::update(&f.database, &f.actor, &selector, &settings)
        .await
        .unwrap();
    assert_eq!(renamed.slug, team.slug);
    assert_eq!(renamed.identifier, "NEW");
    teams::archive(&f.database, &f.actor, &selector, Some("Renamed team"))
        .await
        .unwrap();
    assert!(
        teams::get(&f.database, &f.actor, &selector)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        teams::directory(&f.database, &f.actor, true).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let replacement = teams::create(&f.database, &f.actor, &team_input(1))
        .await
        .unwrap();
    assert!(matches!(
        teams::restore(&f.database, &f.actor, &selector).await,
        Err(StoreError::Team(TeamError::RestoreConflict))
    ));
    teams::archive(&f.database, &f.actor, &Selector::Id(replacement.id), None)
        .await
        .unwrap();
    teams::restore(&f.database, &f.actor, &selector)
        .await
        .unwrap();
    teams::archive(&f.database, &f.actor, &selector, None)
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET deleted_at=now()-interval '31 days' WHERE id=$1")
        .bind(team.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        teams::restore(&f.database, &f.actor, &selector).await,
        Err(StoreError::Team(TeamError::NotFound))
    ));
    let statuses: i64 = sqlx::query_scalar("SELECT count(*) FROM issue_statuses WHERE team_id=$1")
        .bind(team.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(statuses, 7);
}

#[tokio::test]
async fn private_teams_are_filtered_before_pagination_and_membership_changes_are_atomic() {
    use forge_store::teams::{self, Selector};
    let f = Fixture::new().await;
    let guest = Fixture::new().await;
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let a = teams::create(&f.database, &f.actor, &team_input(1))
        .await
        .unwrap();
    let b = teams::create(&f.database, &f.actor, &team_input(2))
        .await
        .unwrap();
    let c = teams::create(&f.database, &f.actor, &team_input(3))
        .await
        .unwrap();
    let d = teams::create(&f.database, &f.actor, &team_input(4))
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=ANY($1)")
        .bind(vec![a.id, c.id])
        .execute(&f.pool)
        .await
        .unwrap();
    let actor = enter_workspace(&f, &guest).await;
    let first = teams::list(&guest.database, &actor, None, 1).await.unwrap();
    assert_eq!(first["items"][0]["id"], json!(b.id));
    let second = teams::list(&guest.database, &actor, first["nextCursor"].as_str(), 1)
        .await
        .unwrap();
    assert_eq!(second["items"][0]["id"], json!(d.id));
    assert!(second["nextCursor"].is_null());
    assert!(
        teams::get(&guest.database, &actor, &Selector::Id(a.id))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        teams::join(&guest.database, &actor, &Selector::Id(a.id), false)
            .await
            .is_err()
    );
    assert!(
        teams::add_members(
            &f.database,
            &f.actor,
            &Selector::Id(a.id),
            &[actor.user_id.clone(), "foreign-user".into()]
        )
        .await
        .is_err()
    );
    let dir = teams::member_directory(&f.database, &f.actor, &Selector::Id(a.id))
        .await
        .unwrap();
    assert_eq!(dir["members"].as_array().unwrap().len(), 1);
    teams::add_members(
        &f.database,
        &f.actor,
        &Selector::Id(a.id),
        std::slice::from_ref(&actor.user_id),
    )
    .await
    .unwrap();
    assert!(
        teams::get(&guest.database, &actor, &Selector::Id(a.id))
            .await
            .unwrap()
            .is_some()
    );
    let directory = teams::directory(&guest.database, &actor, false)
        .await
        .unwrap();
    assert_eq!(directory["items"].as_array().unwrap().len(), 3);
    assert_eq!(directory["canCreateTeam"], false);
    let member_dir = teams::member_directory(&guest.database, &actor, &Selector::Id(a.id))
        .await
        .unwrap();
    assert!(
        member_dir["availableMembers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn competing_team_leads_cannot_both_leave() {
    use forge_store::teams::{self, Selector};
    let f = Fixture::new().await;
    let guest = Fixture::new().await;
    let actor = enter_workspace(&f, &guest).await;
    let team = teams::create(&f.database, &f.actor, &team_input(1))
        .await
        .unwrap();
    let selector = Selector::Id(team.id);
    teams::add_members(
        &f.database,
        &f.actor,
        &selector,
        std::slice::from_ref(&actor.user_id),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE team_members SET role='lead' WHERE team_id=$1")
        .bind(team.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        teams::join(&f.database, &f.actor, &selector, true),
        teams::join(&guest.database, &actor, &selector, true)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(
            a,
            Err(StoreError::Team(forge_core::teams::TeamError::LastLead))
        ) || matches!(
            b,
            Err(StoreError::Team(forge_core::teams::TeamError::LastLead))
        )
    );
    let leads: i64 =
        sqlx::query_scalar("SELECT count(*) FROM team_members WHERE team_id=$1 AND role='lead'")
            .bind(team.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(leads, 1);
}

#[tokio::test]
async fn api_key_names_use_the_current_reference_unicode_length_and_trim_rules() {
    let f = Fixture::new().await;
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for case in fixtures["teamContracts"]["keyNames"].as_array().unwrap() {
        let input: forge_store::api_keys::CreateKey =
            serde_json::from_value(case["input"].clone()).unwrap();
        let result = forge_store::api_keys::create(&f.database, &f.actor, &input).await;
        assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(value) = result {
            assert_eq!(value["summary"]["name"], case["expected"]["name"]);
        }
    }
}

const INVITE_SECRET: &str = "test-workspace-invite-secret-only-1234";
struct Dns(Vec<String>);
#[async_trait]
impl forge_store::security::TxtResolver for Dns {
    async fn records(&self, _domain: &str) -> Result<Vec<String>, StoreError> {
        Ok(self.0.clone())
    }
}
async fn security_snapshot(f: &Fixture) -> Value {
    forge_store::security::snapshot(
        &f.database,
        &f.actor,
        "http://localhost:3100",
        INVITE_SECRET,
    )
    .await
    .unwrap()
}
async fn security_change(f: &Fixture, input: Value, dns: &Dns) -> Result<Value, StoreError> {
    let command = serde_json::from_value(input).unwrap();
    forge_store::security::execute(
        &f.database,
        &f.actor,
        &command,
        dns,
        "http://localhost:3100",
        INVITE_SECRET,
    )
    .await
}

#[tokio::test]
async fn security_commands_check_live_plan_and_version_before_any_domain_effect() {
    let f = Fixture::new().await;
    let initial = security_snapshot(&f).await;
    assert_eq!(initial["version"], 1);
    assert_eq!(initial["plan"], "free");
    assert_eq!(
        initial["settings"],
        serde_json::to_value(forge_core::security::SecuritySettings::default()).unwrap()
    );
    assert!(matches!(security_change(&f,json!({"type":"set-boolean","key":"restrictFileUploads","value":true,"expectedVersion":1}),&Dns(vec![])).await,Err(StoreError::PlanRequired(_))));
    assert_eq!(security_snapshot(&f).await["version"], 1);
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status,source) VALUES($1,'enterprise','active','internal')").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let changed = security_change(
        &f,
        json!({"type":"set-boolean","key":"restrictFileUploads","value":true,"expectedVersion":1}),
        &Dns(vec![]),
    )
    .await
    .unwrap();
    assert_eq!(changed["version"], 2);
    assert_eq!(changed["settings"]["restrictFileUploads"], true);
    let first = json!({"type":"add-domain","domain":"First.Example.","expectedVersion":2});
    let second = json!({"type":"add-domain","domain":"Second.Example.","expectedVersion":2});
    let dns = Dns(vec![]);
    let (a, b) = tokio::join!(
        security_change(&f, first, &dns),
        security_change(&f, second, &dns)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(a, Err(StoreError::Conflict)) || matches!(b, Err(StoreError::Conflict)));
    let current = security_snapshot(&f).await;
    assert_eq!(current["version"], 3);
    assert_eq!(current["domains"].as_array().unwrap().len(), 1);
    let rejected:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND outcome='rejected'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(rejected, 2);
    // A cached admin actor cannot bypass a live role downgrade.
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        security_change(
            &f,
            json!({"type":"reset-invite-link","expectedVersion":3}),
            &dns
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let version: i32 =
        sqlx::query_scalar("SELECT version FROM workspace_security_settings WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(version, 3);
}

#[tokio::test]
async fn domain_proofs_are_expiring_workspace_bound_and_globally_unique() {
    let a = Fixture::new().await;
    let b = Fixture::new().await;
    let domain = format!("{}.example", Uuid::new_v4());
    let first = security_change(
        &a,
        json!({"type":"add-domain","domain":domain,"expectedVersion":1}),
        &Dns(vec![]),
    )
    .await
    .unwrap();
    let id = first["domains"][0]["id"].clone();
    let code = first["domains"][0]["verificationCode"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(matches!(
        security_change(
            &a,
            json!({"type":"verify-domain","domainId":id,"expectedVersion":2}),
            &Dns(vec!["wrong".into()])
        )
        .await,
        Err(StoreError::DomainUnverified)
    ));
    assert_eq!(security_snapshot(&a).await["version"], 2);
    let verified = security_change(
        &a,
        json!({"type":"verify-domain","domainId":id,"expectedVersion":2}),
        &Dns(vec![code]),
    )
    .await
    .unwrap();
    assert!(verified["domains"][0]["verificationCode"].is_null());
    assert!(verified["domains"][0]["verifiedAt"].is_string());
    let pending = security_change(
        &b,
        json!({"type":"add-domain","domain":domain,"expectedVersion":1}),
        &Dns(vec![]),
    )
    .await
    .unwrap();
    let id = pending["domains"][0]["id"].clone();
    let code = pending["domains"][0]["verificationCode"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(matches!(
        security_change(
            &b,
            json!({"type":"verify-domain","domainId":id,"expectedVersion":2}),
            &Dns(vec![code.clone()])
        )
        .await,
        Err(StoreError::DomainTaken)
    ));
    assert!(security_snapshot(&b).await["domains"][0]["verifiedAt"].is_null());
    sqlx::query("UPDATE workspace_approved_domains SET verification_expires_at=now()-interval '1 second' WHERE workspace_id=$1").bind(&b.actor.workspace_id).execute(&b.pool).await.unwrap();
    assert!(matches!(
        security_change(
            &b,
            json!({"type":"verify-domain","domainId":id,"expectedVersion":2}),
            &Dns(vec![code])
        )
        .await,
        Err(StoreError::DomainUnverified)
    ));
}

#[tokio::test]
async fn api_keys_are_scoped_to_creator_workspace_and_current_creation_policy() {
    use forge_store::api_keys::{self, CreateKey};
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let input = CreateKey {
        name: " Read and write ".into(),
        expires_in_days: 90,
        scopes: vec![
            ApiScope::IssuesRead,
            ApiScope::IssuesWrite,
            ApiScope::IssuesRead,
        ],
    };
    let created = api_keys::create(&f.database, &f.actor, &input)
        .await
        .unwrap();
    let key = created["key"].as_str().unwrap();
    let id = created["summary"]["id"].as_str().unwrap();
    assert_eq!(created["summary"]["name"], "Read and write");
    assert_eq!(
        created["summary"]["scopes"],
        json!(["issues:read", "issues:write"])
    );
    let listed = api_keys::list(&f.database, &f.actor).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(!serde_json::to_string(&listed).unwrap().contains(key));
    assert!(
        api_keys::list(&other.database, &other.actor)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        api_keys::revoke(&other.database, &other.actor, id).await,
        Err(StoreError::NotFound)
    ));
    let actor = api_key_actor(&f.database, key).await.unwrap();
    assert!(actor.has_scope(ApiScope::IssuesWrite));
    assert!(!actor.has_scope(ApiScope::TeamsRead));
    security_change(&f,json!({"type":"set-policy","key":"apiKeyCreationPolicy","value":"admins","expectedVersion":1}),&Dns(vec![])).await.unwrap();
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        api_keys::policy(&f.database, &f.actor).await.unwrap()["canCreate"],
        false
    );
    assert!(matches!(
        api_keys::create(&f.database, &f.actor, &input).await,
        Err(StoreError::Forbidden)
    ));
    api_keys::revoke(&f.database, &f.actor, id).await.unwrap();
    assert!(api_key_actor(&f.database, key).await.is_err());
    assert!(
        api_keys::list(&f.database, &f.actor)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn concurrent_owner_demotions_preserve_an_owner_and_revoke_live_privilege() {
    use forge_store::members;
    let f = Fixture::new().await;
    sqlx::query("UPDATE member SET role='owner' WHERE organization_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let other = Uuid::new_v4().to_string();
    let session = Uuid::new_v4().to_string();
    let member = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Second owner',$2,true)",
    )
    .bind(&other)
    .bind(format!("{other}@example.test"))
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')")
        .bind(&member)
        .bind(&f.actor.workspace_id)
        .bind(&other)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')").bind(&session).bind(&other).bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let second = Actor {
        user_id: other,
        workspace_id: f.actor.workspace_id.clone(),
        workspace_role: "owner".into(),
        authentication: Authentication::Session {
            session_id: session,
        },
        scopes: None,
        loop_scope: None,
    };
    let first_member: String =
        sqlx::query_scalar("SELECT id FROM member WHERE user_id=$1 AND organization_id=$2")
            .bind(&f.actor.user_id)
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(
        members::change(&f.database, &f.actor, &first_member, Some("member"), false),
        members::change(&f.database, &second, &member, Some("member"), false)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let owners: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member WHERE organization_id=$1 AND role='owner'")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(owners, 1);
    assert!(matches!(
        members::change(&f.database, &f.actor, &member, Some("made-up"), false).await,
        Err(StoreError::InvalidInput)
    ));
}

#[tokio::test]
async fn invitations_reuse_pending_identity_and_cannot_cross_workspace_boundaries() {
    use forge_store::members::{self, Invite};
    let f = Fixture::new().await;
    let foreign = Fixture::new().await;
    let input = Invite {
        email: format!("{}@example.test", Uuid::new_v4()),
        role: "member".into(),
        resend: false,
    };
    let first = members::invite(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert!(matches!(
        members::invite(&f.database, &f.actor, &input).await,
        Err(StoreError::Conflict)
    ));
    let resend = Invite {
        resend: true,
        ..input
    };
    let renewed = members::invite(&f.database, &f.actor, &resend)
        .await
        .unwrap();
    assert_eq!(renewed.id, first.id);
    assert!(renewed.expires_at >= first.expires_at);
    assert!(matches!(
        members::cancel_invitation(&foreign.database, &foreign.actor, &first.id).await,
        Err(StoreError::NotFound)
    ));
    let canceled = members::cancel_invitation(&f.database, &f.actor, &first.id)
        .await
        .unwrap();
    assert_eq!(canceled.status, "canceled");
    let access = members::summary(&f.database, &f.actor).await.unwrap();
    assert!(access["invitations"].as_array().unwrap().is_empty());
    assert_eq!(access["members"][0]["userId"], f.actor.user_id);
}

#[tokio::test]
async fn join_links_recheck_generation_and_never_demote_existing_members() {
    use forge_store::joins;
    let f = Fixture::new().await;
    let guest = Fixture::new().await;
    let initial = security_snapshot(&f).await;
    let token = initial["inviteLink"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let preview = joins::preview(&f.database, token, INVITE_SECRET)
        .await
        .unwrap();
    assert_eq!(preview["workspaceName"], "Test workspace");
    joins::join_invite(&f.database, &f.token, token, INVITE_SECRET)
        .await
        .unwrap();
    let role: String =
        sqlx::query_scalar("SELECT role FROM member WHERE organization_id=$1 AND user_id=$2")
            .bind(&f.actor.workspace_id)
            .bind(&f.actor.user_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(role, "admin");
    joins::join_invite(&guest.database, &guest.token, token, INVITE_SECRET)
        .await
        .unwrap();
    assert_eq!(
        session_actor(&guest.database, &guest.token)
            .await
            .unwrap()
            .workspace_id,
        f.actor.workspace_id
    );
    security_change(
        &f,
        json!({"type":"reset-invite-link","expectedVersion":1}),
        &Dns(vec![]),
    )
    .await
    .unwrap();
    assert!(
        joins::join_invite(&guest.database, &guest.token, token, INVITE_SECRET)
            .await
            .is_err()
    );
    assert!(
        joins::preview(&f.database, token, INVITE_SECRET)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn approved_domain_joins_use_current_verified_email_and_current_domain_binding() {
    use forge_store::joins;
    let f = Fixture::new().await;
    let applicant = Fixture::new().await;
    let outsider = Fixture::new().await;
    let domain = format!("{}.example", Uuid::new_v4());
    let pending = security_change(
        &f,
        json!({"type":"add-domain","domain":domain,"expectedVersion":1}),
        &Dns(vec![]),
    )
    .await
    .unwrap();
    let id = pending["domains"][0]["id"].clone();
    let code = pending["domains"][0]["verificationCode"]
        .as_str()
        .unwrap()
        .to_owned();
    sqlx::query("UPDATE \"user\" SET email=$1 WHERE id=$2")
        .bind(format!("applicant@{domain}"))
        .bind(&applicant.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        joins::approved_workspace(&applicant.database, &applicant.token)
            .await
            .unwrap()
            .is_null()
    );
    security_change(
        &f,
        json!({"type":"verify-domain","domainId":id,"expectedVersion":2}),
        &Dns(vec![code]),
    )
    .await
    .unwrap();
    let eligible = joins::approved_workspace(&applicant.database, &applicant.token)
        .await
        .unwrap();
    assert_eq!(eligible["workspaceId"], f.actor.workspace_id);
    assert!(matches!(
        joins::join_domain(
            &applicant.database,
            &applicant.token,
            &outsider.actor.workspace_id
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let joined = joins::join_domain(&applicant.database, &applicant.token, &f.actor.workspace_id)
        .await
        .unwrap();
    assert_eq!(joined["domain"], domain);
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&applicant.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        joins::join_domain(&applicant.database, &applicant.token, &f.actor.workspace_id).await,
        Err(StoreError::EmailNotVerified)
    ));
    security_change(
        &f,
        json!({"type":"remove-domain","domainId":id,"expectedVersion":3}),
        &Dns(vec![]),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE \"user\" SET email=$1 WHERE id=$2")
        .bind(format!("outsider@{domain}"))
        .bind(&outsider.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        joins::join_domain(&outsider.database, &outsider.token, &f.actor.workspace_id).await,
        Err(StoreError::Forbidden)
    ));
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM member WHERE organization_id=$1 AND user_id=$2)",
    )
    .bind(&f.actor.workspace_id)
    .bind(&outsider.actor.user_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!exists);
}

struct Fixture {
    pool: PgPool,
    database: forge_store::Database,
    actor: Actor,
    token: String,
}

impl Fixture {
    async fn new() -> Self {
        // This suite fails without the isolated runner instead of silently skipping.
        let connection = std::env::var("FORGE_RUST_TEST_DATABASE_URL")
            .expect("Run bun run rewrite:verify, or python3 scripts/test-rust-postgres.py");
        let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
        assert_eq!(
            options.get_host(),
            "127.0.0.1",
            "Tests require disposable loopback PostgreSQL"
        );
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect_with(options)
            .await
            .unwrap();
        let user_id = Uuid::new_v4().to_string();
        let workspace_id = Uuid::new_v4().to_string();
        let session_id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Original Actor',$2,true)")
            .bind(&user_id).bind(format!("{user_id}@example.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Test workspace',$1)")
            .bind(&workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')")
            .bind(Uuid::new_v4().to_string())
            .bind(&workspace_id)
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')")
            .bind(&session_id).bind(&token).bind(&user_id).bind(&workspace_id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO account_preferences(user_id) VALUES($1)")
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        let actor = Actor {
            user_id,
            workspace_id,
            workspace_role: "owner".into(),
            authentication: Authentication::Session { session_id },
            scopes: None,
            loop_scope: None,
        };
        Self {
            database: forge_store::Database::new(pool.clone()),
            pool,
            actor,
            token,
        }
    }

    async fn create_key(&self, maximum: i32) -> (String, String) {
        let credential = format!("forge_{}", Uuid::new_v4());
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO apikey(id,config_id,reference_id,key,permissions,metadata,rate_limit_time_window,rate_limit_max) VALUES($1,'forge-api',$2,$3,$4,$5,60000,$6)")
            .bind(&id).bind(&self.actor.user_id).bind(api_key_hash(&credential))
            .bind(json!({"issues":["read","write"],"teams":["read"]}).to_string())
            .bind(json!({"workspaceId":self.actor.workspace_id}).to_string()).bind(maximum).execute(&self.pool).await.unwrap();
        (credential, id)
    }

    async fn effect_count(&self) -> i32 {
        sqlx::query_scalar("SELECT revision FROM account_preferences WHERE user_id=$1")
            .bind(&self.actor.user_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

struct PreferenceChange {
    fail_after_write: bool,
    require_admin: bool,
}

#[async_trait]
impl CommandHandler for PreferenceChange {
    type Output = Value;

    async fn authorize(
        &self,
        _connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&Value>,
    ) -> Result<(), StoreError> {
        actor
            .require_scope(ApiScope::IssuesWrite)
            .map_err(|_| StoreError::Forbidden)?;
        if self.require_admin && !actor.has_role(&["admin", "owner"]) {
            return Err(StoreError::Forbidden);
        }
        if value.is_some_and(|value| value["workspaceId"].as_str() != Some(&actor.workspace_id)) {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }

    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Value>, StoreError> {
        let revision: i32 = sqlx::query_scalar("UPDATE account_preferences SET revision=revision+1 WHERE user_id=$1 RETURNING revision")
            .bind(&actor.user_id).fetch_one(connection).await?;
        if self.fail_after_write {
            return Err(StoreError::InvalidInput);
        }
        Ok(CommandResult {
            value: json!({"workspaceId": actor.workspace_id, "revision": revision}),
            resource_type: "preferences".into(),
            resource_id: actor.user_id.clone(),
            events: vec![OutboxEvent {
                topic: "issue.fixture".into(),
                payload: serde_json::Map::new(),
            }],
        })
    }
}

fn command<'a>(key: &'a str, input: &'a Value) -> Command<'a> {
    Command {
        key,
        operation: "fixture.preferences",
        input,
        status: 200,
    }
}

#[tokio::test]
async fn session_authority_uses_live_membership_verification_and_expiry() {
    let fixture = Fixture::new().await;
    let actor = session_actor(&fixture.database, &fixture.token)
        .await
        .unwrap();
    assert_eq!(actor.workspace_role, "admin");
    assert!(actor.scopes.is_none());
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&actor.user_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        session_actor(&fixture.database, &fixture.token).await,
        Err(StoreError::EmailNotVerified)
    ));
    sqlx::query("UPDATE session SET expires_at=now()-interval '1 second' WHERE token=$1")
        .bind(&fixture.token)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        session_actor(&fixture.database, &fixture.token).await,
        Err(StoreError::Unauthenticated)
    ));
}

#[tokio::test]
async fn session_falls_back_to_a_live_workspace_and_persists_the_selection() {
    let fixture = Fixture::new().await;
    sqlx::query("UPDATE session SET active_organization_id=NULL WHERE token=$1")
        .bind(&fixture.token)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let actor = session_actor(&fixture.database, &fixture.token)
        .await
        .unwrap();
    assert_eq!(actor.workspace_id, fixture.actor.workspace_id);
    let active: Option<String> =
        sqlx::query_scalar("SELECT active_organization_id FROM session WHERE token=$1")
            .bind(&fixture.token)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(active.as_deref(), Some(actor.workspace_id.as_str()));
}

#[tokio::test]
async fn concurrent_key_checks_cannot_exceed_the_rate_limit() {
    let fixture = Fixture::new().await;
    let (credential, _) = fixture.create_key(3).await;
    let mut tasks = vec![];
    for _ in 0..12 {
        let pool = fixture.database.clone();
        let credential = credential.clone();
        tasks.push(tokio::spawn(async move {
            api_key_actor(&pool, &credential).await
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(actor) => {
                accepted += 1;
                assert_eq!(actor.workspace_role, "admin");
                assert!(!actor.has_scope(ApiScope::TeamsWrite));
            }
            Err(StoreError::RateLimited) => {}
            other => panic!("Unexpected credential result: {other:?}"),
        }
    }
    assert_eq!(accepted, 3);
}

#[tokio::test]
async fn api_key_scopes_are_intersected_with_live_authority() {
    let fixture = Fixture::new().await;
    let (credential, key_id) = fixture.create_key(600).await;
    let actor = api_key_actor(&fixture.database, &credential).await.unwrap();
    assert!(actor.has_scope(ApiScope::IssuesWrite));
    sqlx::query("UPDATE apikey SET permissions=$1 WHERE id=$2")
        .bind(json!({"issues":["read"]}).to_string())
        .bind(&key_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let mut tx = fixture.pool.begin().await.unwrap();
    let refreshed = current_actor(&mut tx, &actor).await.unwrap();
    assert_eq!(refreshed.scopes, Some(vec![ApiScope::IssuesRead]));
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE apikey SET enabled=false WHERE id=$1")
        .bind(&key_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        api_key_actor(&fixture.database, &credential).await,
        Err(StoreError::Unauthenticated)
    ));
}

#[tokio::test]
async fn concurrent_retries_commit_one_effect_audit_and_outbox() {
    let fixture = Fixture::new().await;
    let mut tasks = vec![];
    for _ in 0..8 {
        let pool = fixture.database.clone();
        let actor = fixture.actor.clone();
        tasks.push(tokio::spawn(async move {
            execute(
                &pool,
                &actor,
                command("same-key", &json!({"a":1})),
                &PreferenceChange {
                    fail_after_write: false,
                    require_admin: true,
                },
            )
            .await
        }));
    }
    let mut fresh = 0;
    for task in tasks {
        let result = task.await.unwrap().unwrap();
        if !result.replayed {
            fresh += 1;
        }
        assert_eq!(result.value["revision"], 1);
    }
    assert_eq!(fresh, 1);
    assert_eq!(fixture.effect_count().await, 1);
    let audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM command_audit_events WHERE workspace_id=$1")
            .bind(&fixture.actor.workspace_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(audits, 1);
    let payloads: Vec<(Value,)> =
        sqlx::query_as("SELECT payload FROM command_outbox_events WHERE workspace_id=$1")
            .bind(&fixture.actor.workspace_id)
            .fetch_all(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(
        payloads[0].0["history"]["actor"]["userId"],
        fixture.actor.user_id
    );
    assert_eq!(payloads[0].0["history"]["actor"]["name"], "Original Actor");
}

#[tokio::test]
async fn failed_effect_rolls_back_the_reservation_and_can_be_retried() {
    let fixture = Fixture::new().await;
    let input = json!({"a":1});
    let result = execute(
        &fixture.database,
        &fixture.actor,
        command("retry-key", &input),
        &PreferenceChange {
            fail_after_write: true,
            require_admin: true,
        },
    )
    .await;
    assert!(matches!(result, Err(StoreError::InvalidInput)));
    assert_eq!(fixture.effect_count().await, 0);
    let receipt_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM command_receipts WHERE workspace_id=$1")
            .bind(&fixture.actor.workspace_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(receipt_count, 0);
    assert!(
        !execute(
            &fixture.database,
            &fixture.actor,
            command("retry-key", &input),
            &PreferenceChange {
                fail_after_write: false,
                require_admin: true
            }
        )
        .await
        .unwrap()
        .replayed
    );
    assert_eq!(fixture.effect_count().await, 1);
}

#[tokio::test]
async fn changed_input_and_revoked_authority_cannot_replay_a_receipt() {
    let fixture = Fixture::new().await;
    let handler = PreferenceChange {
        fail_after_write: false,
        require_admin: true,
    };
    execute(
        &fixture.database,
        &fixture.actor,
        command("saved-key", &json!({"a":1})),
        &handler,
    )
    .await
    .unwrap();
    assert!(matches!(
        execute(
            &fixture.database,
            &fixture.actor,
            command("saved-key", &json!({"a":2})),
            &handler
        )
        .await,
        Err(StoreError::CommandReused)
    ));
    sqlx::query("UPDATE member SET role='member' WHERE user_id=$1 AND organization_id=$2")
        .bind(&fixture.actor.user_id)
        .bind(&fixture.actor.workspace_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        execute(
            &fixture.database,
            &fixture.actor,
            command("saved-key", &json!({"a":1})),
            &handler
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(fixture.effect_count().await, 1);
}

#[tokio::test]
async fn unavailable_receipts_fail_without_repeating_the_effect() {
    let fixture = Fixture::new().await;
    let handler = PreferenceChange {
        fail_after_write: false,
        require_admin: true,
    };
    execute(
        &fixture.database,
        &fixture.actor,
        command("saved-key", &json!({"a":1})),
        &handler,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE command_receipts SET response_body=NULL WHERE workspace_id=$1")
        .bind(&fixture.actor.workspace_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        execute(
            &fixture.database,
            &fixture.actor,
            command("saved-key", &json!({"a":1})),
            &handler
        )
        .await,
        Err(StoreError::CommandResultUnavailable)
    ));
    assert_eq!(fixture.effect_count().await, 1);
}

#[path = "acceptance/preferences.rs"]
mod preference_acceptance;
