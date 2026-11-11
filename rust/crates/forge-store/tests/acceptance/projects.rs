use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, team},
};
use forge_core::{
    actor::{Actor, ApiScope},
    issues::EditIssues,
};
use forge_store::{StoreError, api_keys, authority, issues, projects};
use serde_json::{Value, json};
use uuid::Uuid;
fn creation(id: Uuid, teams: &[Uuid]) -> Value {
    json!({"id":id,"expectedRevision":null,"changes":{"name":"Project","teamIds":teams}})
}
async fn save(f: &Fixture, a: &Actor, changes: Value) -> Result<Value, StoreError> {
    projects::save(&f.database, a, &Uuid::new_v4().to_string(), changes).await
}
async fn row(f: &Fixture, a: &Actor, id: Uuid) -> Value {
    projects::read(&f.database, a).await.unwrap()["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id.to_string())
        .unwrap()
        .clone()
}
async fn edit(f: &Fixture, a: &Actor, id: Uuid, changes: Value) -> Result<Value, StoreError> {
    let old = row(f, a, id).await;
    save(
        f,
        a,
        json!([{"id":id,"expectedRevision":old["revision"],"changes":changes}]),
    )
    .await
}
async fn private(f: &Fixture, team: Uuid) {
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
}
async fn assign(f: &Fixture, team: Uuid, issue: &Value, project: Uuid, milestone: &str) {
    let input=EditIssues::parse(json!({"teamId":team,"commandKey":Uuid::new_v4(),"edits":[{"issueId":issue["id"],"expectedRevision":issue["revision"],"changes":{"project":project,"milestone":milestone}}]})).unwrap();
    issues::edit(
        &f.database,
        &f.actor,
        &input,
        issues::IssueOptions::default(),
    )
    .await
    .unwrap();
}
fn milestone() -> Value {
    json!({"id":"milestone","name":"Release","completed":false,"description":{"type":"doc","content":[]}})
}
fn post(id: Uuid) -> Value {
    json!({"id":id,"text":"Post","health":"On track","authorId":"forged","createdAt":"2000-01-01T00:00:00Z","attachments":[],"reactions":[],"comments":[]})
}

#[tokio::test]
async fn shared_edits_preserve_hidden_links_and_dependencies_and_refuse_invisible_references() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let public = team(&f, 1).await;
    let hidden = team(&f, 2).await;
    private(&f, hidden).await;
    let (shared, secret) = (Uuid::new_v4(), Uuid::new_v4());
    save(
        &f,
        &f.actor,
        json!([
            creation(shared, &[public, hidden]),
            creation(secret, &[hidden])
        ]),
    )
    .await
    .unwrap();
    edit(&f, &f.actor, shared, json!({"dependencyIds":[secret]}))
        .await
        .unwrap();
    let visible = row(&f, &member, shared).await;
    assert_eq!(visible["teamIds"], json!([public]));
    assert_eq!(visible["dependencyIds"], json!([]));
    edit(
        &f,
        &member,
        shared,
        json!({"name":"Member edit","teamIds":[public],"dependencyIds":[]}),
    )
    .await
    .unwrap();
    let owner = row(&f, &f.actor, shared).await;
    assert_eq!(owner["teamIds"].as_array().unwrap().len(), 2);
    assert_eq!(owner["dependencyIds"], json!([secret]));
    assert!(matches!(
        edit(&f, &member, shared, json!({"teamIds":[public,hidden]})).await,
        Err(StoreError::Forbidden)
    ));
    assert!(
        edit(&f, &member, shared, json!({"dependencyIds":[secret]}))
            .await
            .is_err()
    );
    assert!(
        save(
            &f,
            &member,
            json!([{"id":secret,"expectedRevision":1,"changes":{"name":"No"}}])
        )
        .await
        .is_err()
    );
    assert!(
        edit(&f, &f.actor, secret, json!({"dependencyIds":[shared]}))
            .await
            .is_err()
    );
    let external = Fixture::new().await;
    let foreign = Uuid::new_v4();
    save(&external, &external.actor, json!([creation(foreign, &[])]))
        .await
        .unwrap();
    assert!(
        save(
            &f,
            &f.actor,
            json!([{ "id":foreign,"expectedRevision":0,"changes":{"name":"No"}}])
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn project_receipts_and_competing_revisions_commit_once_and_batches_roll_back() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    let command = Uuid::new_v4().to_string();
    let changes = json!([creation(id, &[])]);
    let (a, b) = tokio::join!(
        projects::save(&f.database, &f.actor, &command, changes.clone()),
        projects::save(&f.database, &f.actor, &command, changes.clone())
    );
    assert_ne!(a.unwrap()["replayed"], b.unwrap()["replayed"]);
    let mut changed = changes.clone();
    changed[0]["changes"]["name"] = json!("Other");
    assert!(matches!(
        projects::save(&f.database, &f.actor, &command, changed).await,
        Err(StoreError::CommandReused)
    ));
    let old = row(&f, &f.actor, id).await;
    let a = json!([{"id":id,"expectedRevision":old["revision"],"changes":{"summary":"A"}}]);
    let b = json!([{"id":id,"expectedRevision":old["revision"],"changes":{"summary":"B"}}]);
    let (a, b) = tokio::join!(save(&f, &f.actor, a), save(&f, &f.actor, b));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let new = Uuid::new_v4();
    assert!(save(&f,&f.actor,json!([creation(new,&[]),{"id":id,"expectedRevision":old["revision"],"changes":{"name":"Stale"}}])).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM projects WHERE id=$1")
            .bind(new)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='project.created'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 1);
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        projects::save(&f.database, &f.actor, &command, changes)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn project_scope_does_not_require_issue_scope_but_relocation_does() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let key = api_keys::create(
        &f.database,
        &f.actor,
        &api_keys::CreateKey {
            name: "Projects".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::ProjectsRead, ApiScope::ProjectsWrite],
        },
    )
    .await
    .unwrap();
    let a = authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    let id = Uuid::new_v4();
    save(&f, &a, json!([creation(id, &[team])])).await.unwrap();
    edit(&f, &a, id, json!({"milestones":[milestone()]}))
        .await
        .unwrap();
    let p = row(&f, &a, id).await;
    assert!(matches!(save(&f,&a,json!([{"id":id,"expectedRevision":p["revision"],"changes":{},"relocation":{"milestoneId":"milestone"}}])).await,Err(StoreError::Forbidden)));
    let read_key = api_keys::create(
        &f.database,
        &f.actor,
        &api_keys::CreateKey {
            name: "Read".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::ProjectsRead],
        },
    )
    .await
    .unwrap();
    let reader = authority::api_key_actor(&f.database, read_key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        edit(&f, &reader, id, json!({"name":"No"})).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn project_metadata_dates_and_team_changes_respect_existing_issue_assignments() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let p = Uuid::new_v4();
    save(&f, &f.actor, json!([creation(p, &[team])]))
        .await
        .unwrap();
    for fields in [
        json!({"startDate":"2026-Q4","targetDate":"2026-Q1"}),
        json!({"leadId":"missing-user"}),
        json!({"memberIds":["missing-user"]}),
        json!({"labelIds":["missing"]}),
        json!({"statusId":"missing"}),
        json!({"resources":[{"id":"x"}]}),
    ] {
        assert!(edit(&f, &f.actor, p, fields).await.is_err());
    }
    let issue = create(&f, team, "Assigned").await;
    assign(&f, team, &issue, p, "").await;
    assert!(edit(&f, &f.actor, p, json!({"teamIds":[]})).await.is_err());
    edit(
        &f,
        &f.actor,
        p,
        json!({"leadId":f.actor.user_id,"startDate":"2026-Q1","targetDate":"2026-H2"}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn milestone_aliases_history_relocation_conversion_and_deletion_cover_inactive_issues() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let (source, target) = (Uuid::new_v4(), Uuid::new_v4());
    save(
        &f,
        &f.actor,
        json!([creation(source, &[team]), creation(target, &[team])]),
    )
    .await
    .unwrap();
    edit(&f, &f.actor, source, json!({"milestones":[milestone()]}))
        .await
        .unwrap();
    let issue = create(&f, team, "Milestone issue").await;
    assign(&f, team, &issue, source, "Release").await;
    let mut m = milestone();
    m["name"] = json!("Shipping");
    m["description"] = json!(null);
    m["aliases"] = json!(["forged"]);
    edit(&f, &f.actor, source, json!({"milestones":[m]}))
        .await
        .unwrap();
    let p = row(&f, &f.actor, source).await;
    assert_eq!(p["milestones"][0]["aliases"], json!(["Release"]));
    assert_eq!(
        p["milestones"][0]["descriptionHistory"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        edit(&f, &f.actor, source, json!({"milestones":[]}))
            .await
            .is_err()
    );
    let iid = Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE issues SET archived_at=now(),properties=jsonb_set(properties,'{milestone}','\"Release\"'::jsonb) WHERE id=$1").bind(iid).execute(&f.pool).await.unwrap();
    let t = row(&f, &f.actor, target).await;
    let command = Uuid::new_v4().to_string();
    let changes = json!([{"id":source,"expectedRevision":p["revision"],"changes":{},"relocation":{"milestoneId":"milestone","targetId":target,"targetRevision":t["revision"]}}]);
    projects::save(&f.database, &f.actor, &command, changes.clone())
        .await
        .unwrap();
    assert_eq!(
        projects::save(&f.database, &f.actor, &command, changes)
            .await
            .unwrap()["replayed"],
        true
    );
    let stored: (Uuid, Value) =
        sqlx::query_as("SELECT project_id,properties FROM issues WHERE id=$1")
            .bind(iid)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(stored.0, target);
    assert_eq!(stored.1["milestone"], "milestone");
    let converted = Uuid::new_v4();
    let p = row(&f, &f.actor, target).await;
    save(&f,&f.actor,json!([{"id":target,"expectedRevision":p["revision"],"changes":{},"relocation":{"milestoneId":"milestone","convertId":converted}}])).await.unwrap();
    let stored: (Uuid, Value) =
        sqlx::query_as("SELECT project_id,properties FROM issues WHERE id=$1")
            .bind(iid)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(stored.0, converted);
    assert_eq!(stored.1["milestone"], "");
    assert_eq!(row(&f, &f.actor, converted).await["name"], "Shipping");
    edit(&f, &f.actor, converted, json!({"milestones":[milestone()]}))
        .await
        .unwrap();
    sqlx::query("UPDATE issues SET deleted_at=now(),properties=jsonb_set(properties,'{milestone}','\"Release\"'::jsonb) WHERE id=$1").bind(iid).execute(&f.pool).await.unwrap();
    let p = row(&f, &f.actor, converted).await;
    save(&f,&f.actor,json!([{"id":converted,"expectedRevision":p["revision"],"changes":{},"relocation":{"milestoneId":"milestone"}}])).await.unwrap();
    let value: Value = sqlx::query_scalar("SELECT properties FROM issues WHERE id=$1")
        .bind(iid)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(value["milestone"], "");
    let events: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.updated'",
    )
    .bind(&f.actor.workspace_id)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    assert_eq!(events.len(), 4);
    assert!(
        events
            .iter()
            .all(|e| e["history"]["actor"]["userId"] == f.actor.user_id)
    );
}

#[tokio::test]
async fn milestone_mutation_rolls_back_when_an_assignment_is_private_or_purging() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let public = team(&f, 1).await;
    let hidden = team(&f, 2).await;
    private(&f, hidden).await;
    let p = Uuid::new_v4();
    save(&f, &f.actor, json!([creation(p, &[public, hidden])]))
        .await
        .unwrap();
    edit(&f, &f.actor, p, json!({"milestones":[milestone()]}))
        .await
        .unwrap();
    let issue = create(&f, hidden, "Hidden").await;
    assign(&f, hidden, &issue, p, "Release").await;
    let old = row(&f, &member, p).await;
    let changes = json!([{"id":p,"expectedRevision":old["revision"],"changes":{},"relocation":{"milestoneId":"milestone"}}]);
    assert!(matches!(
        save(&f, &member, changes.clone()).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(row(&f, &f.actor, p).await["revision"], old["revision"]);
    sqlx::query(
        "UPDATE issues SET deleted_at=now()-interval '31 days',purge_started_at=now() WHERE id=$1",
    )
    .bind(Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(matches!(
        save(&f, &f.actor, changes).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn catalogs_enforce_live_admin_versions_usage_and_in_use_rules() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let public = team(&f, 1).await;
    let hidden = team(&f, 2).await;
    private(&f, hidden).await;
    let mut statuses = forge_core::projects::initial_statuses();
    statuses["version"] = json!(1);
    statuses["statuses"].as_array_mut().unwrap().push(json!({"id":"review","name":"Review","description":"","group":"in-progress","color":"#123456"}));
    let command = |kind: &str, value: &Value, revision: i32| json!({"commandKey":Uuid::new_v4(),"kind":kind,"value":value.to_string(),"expectedRevision":revision});
    assert!(matches!(
        projects::save_catalog(&f.database, &member, command("statuses", &statuses, 0)).await,
        Err(StoreError::Forbidden)
    ));
    let input = command("statuses", &statuses, 0);
    projects::save_catalog(&f.database, &f.actor, input.clone())
        .await
        .unwrap();
    assert_eq!(
        projects::save_catalog(&f.database, &f.actor, input)
            .await
            .unwrap()["replayed"],
        true
    );
    assert!(
        projects::save_catalog(&f.database, &f.actor, command("statuses", &statuses, 1))
            .await
            .is_err()
    );
    let labels = json!({"version":1,"catalogRevision":0,"labels":[{"id":"release","name":"Release","description":"","color":"#123456","groupId":null,"issues":999,"lastApplied":null,"createdAt":"2026-11-11T00:00:00Z"}],"groups":[],"inheritedCount":999});
    projects::save_catalog(&f.database, &f.actor, command("labels", &labels, 0))
        .await
        .unwrap();
    let ids = [Uuid::new_v4(), Uuid::new_v4()];
    for (id, team) in ids.iter().zip([public, hidden]) {
        let mut create = creation(*id, &[team]);
        create["changes"]["statusId"] = json!("review");
        create["changes"]["labelIds"] = json!(["release"]);
        save(&f, &f.actor, json!([create])).await.unwrap();
    }
    assert_eq!(row(&f, &member, ids[0]).await["status"], "Active");
    let read = projects::read_catalog(&f.database, &member).await.unwrap();
    assert_eq!(read["labels"]["labels"][0]["issues"], 1);
    assert_eq!(read["labels"]["catalogRevision"], 1);
    assert_eq!(read["labels"]["inheritedCount"], 0);
    statuses["version"] = json!(2);
    statuses["statuses"].as_array_mut().unwrap().pop();
    assert!(
        projects::save_catalog(&f.database, &f.actor, command("statuses", &statuses, 1))
            .await
            .is_err()
    );
    let mut removed = labels.clone();
    removed["catalogRevision"] = json!(1);
    removed["labels"] = json!([]);
    assert!(
        projects::save_catalog(&f.database, &f.actor, command("labels", &removed, 1))
            .await
            .is_err()
    );
    let mut archived = labels;
    archived["catalogRevision"] = json!(1);
    archived["labels"][0]["archived"] = json!(true);
    projects::save_catalog(&f.database, &f.actor, command("labels", &archived, 1))
        .await
        .unwrap();
    edit(&f, &member, ids[0], json!({"labelIds":["release"]}))
        .await
        .unwrap();
    let mut fresh = creation(Uuid::new_v4(), &[]);
    fresh["changes"]["labelIds"] = json!(["release"]);
    assert!(save(&f, &member, json!([fresh])).await.is_err());
}

#[tokio::test]
async fn post_authorship_reactions_and_file_binding_use_committed_authority() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let third = Fixture::new().await;
    let reader = enter_workspace(&f, &third).await;
    let p = Uuid::new_v4();
    save(&f, &member, json!([creation(p, &[])])).await.unwrap();
    let file = Uuid::new_v4();
    sqlx::query("INSERT INTO resource_files(id,workspace_id,created_by_user_id,project_id,attachment_state,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,'unbound','verified.txt','text/plain',4,$5,$6)").bind(file).bind(&f.actor.workspace_id).bind(&member.user_id).bind(p).bind("a".repeat(64)).bind(format!("files/{}",Uuid::new_v4())).execute(&f.pool).await.unwrap();
    let mut post = post(Uuid::new_v4());
    post["attachments"] =
        json!([{"id":"fake","fileId":file,"name":"forged.txt","mime":"image/png","sizeBytes":999}]);
    assert!(
        edit(&f, &reader, p, json!({"updates":[post.clone()]}))
            .await
            .is_err()
    );
    edit(&f, &member, p, json!({"updates":[post]}))
        .await
        .unwrap();
    let row1 = row(&f, &member, p).await;
    let mut post = row1["updates"][0].clone();
    assert_eq!(post["authorId"], member.user_id);
    assert_ne!(post["createdAt"], "2000-01-01T00:00:00Z");
    assert_eq!(post["attachments"][0]["name"], "verified.txt");
    assert_eq!(post["attachments"][0]["sizeBytes"], 4);
    post["text"] = json!("Changed");
    assert!(matches!(
        edit(&f, &reader, p, json!({"updates":[post]})).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        edit(&f, &reader, p, json!({"updates":[]})).await,
        Err(StoreError::Forbidden)
    ));
    let mut reacted = row1["updates"][0].clone();
    reacted["reactions"] = json!([{"emoji":"👍","userIds":[reader.user_id]}]);
    edit(&f, &reader, p, json!({"updates":[reacted]}))
        .await
        .unwrap();
    assert!(
        edit(&f, &member, p, json!({"updates":[row1["updates"][0]]}))
            .await
            .is_err()
    );
    edit(&f, &f.actor, p, json!({"updates":[]})).await.unwrap();
    let state: String =
        sqlx::query_scalar("SELECT attachment_state FROM resource_files WHERE id=$1")
            .bind(file)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state, "detached");
}
