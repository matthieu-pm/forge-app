use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, team},
};
use forge_core::{
    actor::{Actor, ApiScope},
    issues::EditIssues,
};
use forge_store::{
    StoreError,
    initiatives::{self, InitiativeOptions},
    issues, projects,
};
use serde_json::{Value, json};
use uuid::Uuid;
pub(super) const ENABLED: InitiativeOptions = InitiativeOptions { enabled: true };
pub(super) async fn project(f: &Fixture, teams: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    projects::save(&f.database,&f.actor,&Uuid::new_v4().to_string(),json!([{"id":id,"expectedRevision":null,"changes":{"name":"Shared project","teamIds":teams}}])).await.unwrap();
    id
}
pub(super) fn creation(id: Uuid, projects: &[Uuid]) -> Value {
    json!({"id":id,"expectedRevision":null,"changes":{"name":"Strategy"},"addProjectIds":projects})
}
async fn save(f: &Fixture, a: &Actor, changes: Value) -> Result<Value, StoreError> {
    initiatives::save(
        &f.database,
        a,
        &Uuid::new_v4().to_string(),
        changes,
        ENABLED,
    )
    .await
}
async fn row(f: &Fixture, a: &Actor, id: Uuid) -> Value {
    initiatives::read(&f.database, a, ENABLED).await.unwrap()["initiatives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id.to_string())
        .unwrap()
        .clone()
}
async fn edit(f: &Fixture, a: &Actor, id: Uuid, changes: Value) -> Result<Value, StoreError> {
    let p = row(f, a, id).await;
    save(
        f,
        a,
        json!([{"id":id,"expectedRevision":p["revision"],"changes":changes}]),
    )
    .await
}
fn post(id: Uuid) -> Value {
    json!({"id":id,"text":"Progress","health":"On track","authorId":"forged","createdAt":"2000-01-01T00:00:00Z","attachments":[],"reactions":[],"comments":[]})
}

#[tokio::test]
async fn initiative_rollups_and_membership_deltas_never_reveal_or_erase_hidden_work() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let public = team(&f, 1).await;
    let hidden = team(&f, 2).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(hidden)
        .execute(&f.pool)
        .await
        .unwrap();
    let shared = project(&f, &[public, hidden]).await;
    let secret = project(&f, &[hidden]).await;
    for (team, project, title, status) in [
        (public, shared, "Visible done", "done"),
        (hidden, shared, "Hidden", "todo"),
        (hidden, secret, "Secret", "todo"),
    ] {
        let issue = create(&f, team, title).await;
        let edit=EditIssues::parse(json!({"teamId":team,"commandKey":Uuid::new_v4(),"edits":[{"issueId":issue["id"],"expectedRevision":issue["revision"],"changes":{"project":project,"status":status}}]})).unwrap();
        issues::edit(
            &f.database,
            &f.actor,
            &edit,
            issues::IssueOptions::default(),
        )
        .await
        .unwrap();
    }
    let id = Uuid::new_v4();
    save(&f, &member, json!([creation(id, &[shared])]))
        .await
        .unwrap();
    let old = row(&f, &f.actor, id).await;
    save(
        &f,
        &f.actor,
        json!([{"id":id,"expectedRevision":old["revision"],"changes":{},"addProjectIds":[secret]}]),
    )
    .await
    .unwrap();
    let visible = row(&f, &member, id).await;
    assert_eq!(
        visible["rollup"],
        json!({"projectCount":1,"completedProjects":0,"issueCount":1,"completedIssues":1,"percent":100})
    );
    assert_eq!(visible["projects"][0]["teamIds"], json!([public]));
    assert_eq!(row(&f, &f.actor, id).await["rollup"]["issueCount"], 3);
    edit(&f, &member, id, json!({"summary":"Member edit"}))
        .await
        .unwrap();
    assert_eq!(
        row(&f, &f.actor, id).await["projects"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let old = row(&f, &member, id).await;
    assert!(matches!(save(&f,&member,json!([{"id":id,"expectedRevision":old["revision"],"changes":{},"removeProjectIds":[secret]}])).await,Err(StoreError::Forbidden)));
    save(&f,&member,json!([{"id":id,"expectedRevision":old["revision"],"changes":{},"removeProjectIds":[shared]}])).await.unwrap();
    assert_eq!(row(&f, &member, id).await["rollup"]["projectCount"], 0);
    assert_eq!(row(&f, &f.actor, id).await["rollup"]["projectCount"], 1);
    // An unrelated legacy project must not enter the initiative's parsing boundary.
    sqlx::query("INSERT INTO projects(workspace_id,name,properties) VALUES($1,'Unlinked legacy','{\"status\":\"old-invalid\"}'::jsonb)").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(row(&f, &member, id).await["rollup"]["projectCount"], 0);
}

#[tokio::test]
async fn initiative_numbering_receipts_conflicts_and_bulk_changes_are_atomic() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    let key = Uuid::new_v4().to_string();
    let input = json!([creation(id, &[])]);
    let (a, b) = tokio::join!(
        initiatives::save(&f.database, &f.actor, &key, input.clone(), ENABLED),
        initiatives::save(&f.database, &f.actor, &key, input.clone(), ENABLED)
    );
    assert_ne!(a.unwrap()["replayed"], b.unwrap()["replayed"]);
    assert_eq!(row(&f, &f.actor, id).await["number"], 1);
    let mut different = input;
    different[0]["changes"]["name"] = json!("Other");
    assert!(matches!(
        initiatives::save(&f.database, &f.actor, &key, different, ENABLED).await,
        Err(StoreError::CommandReused)
    ));
    let old = row(&f, &f.actor, id).await;
    let a = json!([{"id":id,"expectedRevision":old["revision"],"changes":{"name":"A"}}]);
    let b = json!([{"id":id,"expectedRevision":old["revision"],"changes":{"name":"B"}}]);
    let (a, b) = tokio::join!(save(&f, &f.actor, a), save(&f, &f.actor, b));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let pending = Uuid::new_v4();
    assert!(
        save(
            &f,
            &f.actor,
            json!([creation(pending,&[]),{"id":id,"expectedRevision":old["revision"],"changes":{}}])
        )
        .await
        .is_err()
    );
    let list = initiatives::read(&f.database, &f.actor, ENABLED)
        .await
        .unwrap();
    assert_eq!(list["initiatives"].as_array().unwrap().len(), 1);
    assert_eq!(list["nextNumber"], 2);
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let (a, b) = tokio::join!(
        save(&f, &f.actor, json!([creation(a, &[])])),
        save(&f, &f.actor, json!([creation(b, &[])]))
    );
    a.unwrap();
    b.unwrap();
    let numbers: Vec<i32> =
        sqlx::query_scalar("SELECT number FROM initiatives WHERE workspace_id=$1 ORDER BY number")
            .bind(&f.actor.workspace_id)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(numbers, vec![1, 2, 3]);
}

#[tokio::test]
async fn initiative_retry_rechecks_link_visibility_and_session_authority() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let team = team(&f, 1).await;
    let p = project(&f, &[team]).await;
    let id = Uuid::new_v4();
    let key = Uuid::new_v4().to_string();
    let input = json!([creation(id, &[p])]);
    initiatives::save(&f.database, &member, &key, input.clone(), ENABLED)
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        initiatives::save(&f.database, &member, &key, input.clone(), ENABLED).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE teams SET visibility='workspace' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        initiatives::save(&f.database, &member, &key, input.clone(), ENABLED)
            .await
            .unwrap()["replayed"],
        true
    );
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&other.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        initiatives::save(&f.database, &member, &key, input, ENABLED)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn initiative_settings_gate_is_live_revisioned_and_session_only() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let id = Uuid::new_v4();
    let input = json!([creation(id, &[])]);
    assert!(
        initiatives::save(
            &f.database,
            &f.actor,
            &Uuid::new_v4().to_string(),
            input.clone(),
            InitiativeOptions::default()
        )
        .await
        .is_err()
    );
    assert_eq!(
        initiatives::read(&f.database, &f.actor, InitiativeOptions::default())
            .await
            .unwrap(),
        forge_core::initiatives::empty()
    );
    save(&f, &member, input).await.unwrap();
    let disable = json!({"commandKey":Uuid::new_v4(),"expectedRevision":0,"value":"{\"enabled\":false,\"schedule\":\"2-weeks\"}"});
    assert!(matches!(
        initiatives::save_settings(&f.database, &member, disable.clone()).await,
        Err(StoreError::Forbidden)
    ));
    initiatives::save_settings(&f.database, &f.actor, disable.clone())
        .await
        .unwrap();
    assert_eq!(
        initiatives::save_settings(&f.database, &f.actor, disable)
            .await
            .unwrap()["replayed"],
        true
    );
    assert_eq!(
        initiatives::read(&f.database, &member, ENABLED)
            .await
            .unwrap(),
        forge_core::initiatives::empty()
    );
    assert!(
        save(
            &f,
            &member,
            json!([{"id":id,"expectedRevision":1,"changes":{"name":"Blocked"}}])
        )
        .await
        .is_err()
    );
    let enable = json!({"commandKey":Uuid::new_v4(),"expectedRevision":1,"value":"{\"enabled\":true,\"schedule\":\"none\"}"});
    let mut stale = enable.clone();
    stale["expectedRevision"] = json!(0);
    assert!(
        initiatives::save_settings(&f.database, &f.actor, stale)
            .await
            .is_err()
    );
    initiatives::save_settings(&f.database, &f.actor, enable)
        .await
        .unwrap();
    assert_eq!(row(&f, &member, id).await["name"], "Strategy");
    let mut constrained = member.clone();
    constrained.scopes = Some(vec![ApiScope::ProjectsRead]);
    assert!(matches!(
        initiatives::read(&f.database, &constrained, ENABLED).await,
        Err(StoreError::Forbidden)
    ));
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Projects".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::ProjectsRead, ApiScope::ProjectsWrite],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        initiatives::read(&f.database, &actor, ENABLED).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn initiative_posts_keep_attribution_reactions_and_completion_history() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let id = Uuid::new_v4();
    save(&f, &member, json!([creation(id, &[])])).await.unwrap();
    let update = post(Uuid::new_v4());
    edit(
        &f,
        &member,
        id,
        json!({"updates":[update],"status":"Completed"}),
    )
    .await
    .unwrap();
    let first = row(&f, &member, id).await;
    assert_eq!(first["updates"][0]["authorId"], member.user_id);
    assert!(!first["completedAt"].is_null());
    edit(&f, &f.actor, id, json!({"summary":"Reviewed"}))
        .await
        .unwrap();
    assert_eq!(
        row(&f, &member, id).await["completedAt"],
        first["completedAt"]
    );
    let mut p = first["updates"][0].clone();
    p["reactions"] = json!([{"emoji":"👍","userIds":[f.actor.user_id]}]);
    edit(&f, &f.actor, id, json!({"updates":[p]}))
        .await
        .unwrap();
    assert!(matches!(
        edit(&f, &member, id, json!({"updates":[first["updates"][0]]})).await,
        Err(StoreError::Forbidden)
    ));
    let mut bad = post(Uuid::new_v4());
    bad["attachments"] = json!([{"id":"x","name":"x","mime":"text/plain","fileId":Uuid::new_v4()}]);
    assert!(
        edit(&f, &member, id, json!({"updates":[bad]}))
            .await
            .is_err()
    );
    edit(&f, &member, id, json!({"status":"Active"}))
        .await
        .unwrap();
    assert!(row(&f, &member, id).await["completedAt"].is_null());
    edit(&f, &f.actor, id, json!({"updates":[]})).await.unwrap();
    assert_eq!(row(&f, &member, id).await["updates"], json!([]));
}

#[tokio::test]
async fn departed_owner_does_not_block_unrelated_initiative_changes() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let id = Uuid::new_v4();
    save(&f, &f.actor, json!([creation(id, &[])]))
        .await
        .unwrap();
    edit(&f, &f.actor, id, json!({"ownerId":member.user_id}))
        .await
        .unwrap();
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    edit(&f, &f.actor, id, json!({"summary":"Owner left"}))
        .await
        .unwrap();
    edit(&f, &f.actor, id, json!({"comments":[post(Uuid::new_v4())]}))
        .await
        .unwrap();
    assert_eq!(row(&f, &f.actor, id).await["summary"], "Owner left");
    assert!(matches!(
        edit(&f, &f.actor, id, json!({"ownerId":member.user_id})).await,
        Err(StoreError::Forbidden)
    ));
}
