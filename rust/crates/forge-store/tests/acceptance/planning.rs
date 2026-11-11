use super::{
    Fixture, enter_workspace,
    initiative_acceptance::{ENABLED, creation, project},
    issue_acceptance::{create, team},
};
use forge_core::actor::ApiScope;
use forge_store::{
    StoreError, initiatives,
    planning::{self, Relation, Resource},
};
use serde_json::json;
use uuid::Uuid;
#[tokio::test]
async fn planning_pages_exports_and_rollups_apply_visibility_before_limits() {
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
    let projects = [
        project(&f, &[public]).await,
        project(&f, &[]).await,
        project(&f, &[hidden]).await,
    ];
    sqlx::query("UPDATE projects SET name='100%_\\complete' WHERE id=$1")
        .bind(projects[0])
        .execute(&f.pool)
        .await
        .unwrap();
    let page = planning::list(&f.database, &member, Resource::Project, json!({"limit":1}))
        .await
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_string());
    assert_eq!(
        planning::export_page(&f.database, &member, Resource::Project, json!({"limit":1}))
            .await
            .unwrap(),
        page
    );
    let second = planning::list(
        &f.database,
        &member,
        Resource::Project,
        json!({"limit":1,"after":page["nextCursor"]}),
    )
    .await
    .unwrap();
    assert!(second["nextCursor"].is_null());
    assert_ne!(page["items"][0]["id"], second["items"][0]["id"]);
    let literal = planning::list(
        &f.database,
        &member,
        Resource::Project,
        json!({"search":"%_\\"}),
    )
    .await
    .unwrap();
    assert_eq!(literal["items"].as_array().unwrap().len(), 1);
    assert_eq!(literal["items"][0]["id"], projects[0].to_string());
    assert!(
        planning::get(&f.database, &member, Resource::Project, projects[2])
            .await
            .unwrap()
            .is_null()
    );
    assert!(
        planning::rollup(&f.database, &member, Resource::Project, projects[2])
            .await
            .unwrap()
            .is_null()
    );
    let public_issue = create(&f, public, "Visible").await;
    let hidden_issue = create(&f, hidden, "Hidden").await;
    for issue in [&public_issue, &hidden_issue] {
        sqlx::query("UPDATE issues SET project_id=$1 WHERE id=$2")
            .bind(projects[1])
            .bind(Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
            .execute(&f.pool)
            .await
            .unwrap();
    }
    let id = Uuid::new_v4();
    initiatives::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([creation(id, &projects)]),
        ENABLED,
    )
    .await
    .unwrap();
    assert_eq!(
        planning::rollup(&f.database, &member, Resource::Initiative, id)
            .await
            .unwrap()["issueCount"],
        1
    );
    assert_eq!(
        planning::related(&f.database, &member, Relation::InitiativeProjects, id)
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        planning::list(&f.database, &member, Resource::Initiative, json!({}))
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    sqlx::query("UPDATE issues SET archived_at=now() WHERE id=$1")
        .bind(Uuid::parse_str(public_issue["id"].as_str().unwrap()).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        planning::rollup(&f.database, &member, Resource::Project, projects[1])
            .await
            .unwrap()["issueCount"],
        0
    );
    assert!(
        planning::list(
            &f.database,
            &member,
            Resource::Project,
            json!({"limit":101})
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn shared_documents_keep_private_origins_and_issue_relationships_redacted() {
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
    let visible = create(&f, public, "Visible").await;
    let secret = create(&f, hidden, "Secret").await;
    let vid = Uuid::parse_str(visible["id"].as_str().unwrap()).unwrap();
    let sid = Uuid::parse_str(secret["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE issues SET parent_id=$1,project_id=$2 WHERE id=$3")
        .bind(sid)
        .bind(shared)
        .bind(vid)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'related')").bind(&f.actor.workspace_id).bind(vid).bind(sid).execute(&f.pool).await.unwrap();
    let issue = planning::get(&f.database, &member, Resource::Issue, vid)
        .await
        .unwrap();
    assert!(issue["parentId"].is_null());
    assert_eq!(issue["projectId"], shared.to_string());
    assert_eq!(
        planning::related(&f.database, &member, Relation::IssueRelations, vid)
            .await
            .unwrap(),
        json!([])
    );
    let doc = Uuid::new_v4();
    sqlx::query("INSERT INTO documents(id,workspace_id,title,body,issue_id,shared_with_workspace) VALUES($1,$2,'Shared document',$3,$4,true)").bind(doc).bind(&f.actor.workspace_id).bind(json!({"type":"doc","content":[]})).bind(sid).execute(&f.pool).await.unwrap();
    let document = planning::get(&f.database, &member, Resource::Document, doc)
        .await
        .unwrap();
    assert_eq!(document["title"], "Shared document");
    assert!(document["issueId"].is_null());
    assert_eq!(
        planning::related(&f.database, &member, Relation::IssueDocuments, sid)
            .await
            .unwrap(),
        json!([])
    );
    assert_eq!(
        planning::related(&f.database, &member, Relation::ProjectTeams, shared)
            .await
            .unwrap(),
        json!([{"teamId":public}])
    );
    sqlx::query("UPDATE documents SET shared_with_workspace=false WHERE id=$1")
        .bind(doc)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        planning::get(&f.database, &member, Resource::Document, doc)
            .await
            .unwrap()
            .is_null()
    );
    sqlx::query("UPDATE documents SET shared_with_workspace=true,deleted_at=now() WHERE id=$1")
        .bind(doc)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        planning::list(&f.database, &member, Resource::Document, json!({}))
            .await
            .unwrap()["items"],
        json!([])
    );
}

#[tokio::test]
async fn planning_scopes_and_label_counts_exclude_unauthorized_resources() {
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
    let label = Uuid::new_v4();
    sqlx::query("INSERT INTO resource_labels(id,workspace_id,name) VALUES($1,$2,'Label')")
        .bind(label)
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let private_label = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO resource_labels(id,workspace_id,team_id,name) VALUES($1,$2,$3,'Hidden label')",
    )
    .bind(private_label)
    .bind(&f.actor.workspace_id)
    .bind(hidden)
    .execute(&f.pool)
    .await
    .unwrap();
    let project = project(&f, &[]).await;
    let mut visible = None;
    for team in [public, hidden] {
        let issue = create(&f, team, "Labeled").await;
        let id = Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap();
        if team == public {
            visible = Some(id);
        }
        sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
            .bind(&f.actor.workspace_id)
            .bind(id)
            .bind(label)
            .execute(&f.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE issues SET project_id=$1 WHERE id=$2")
            .bind(project)
            .bind(id)
            .execute(&f.pool)
            .await
            .unwrap();
    }
    assert_eq!(
        planning::rollup(&f.database, &member, Resource::Label, label)
            .await
            .unwrap()["issueCount"],
        1
    );
    assert!(
        planning::get(&f.database, &member, Resource::Label, private_label)
            .await
            .unwrap()
            .is_null()
    );
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Issues".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::IssuesRead],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(
        planning::get(&f.database, &actor, Resource::Issue, visible.unwrap())
            .await
            .unwrap()["projectId"]
            .is_null()
    );
    for kind in [
        Resource::Project,
        Resource::Initiative,
        Resource::Document,
        Resource::Label,
    ] {
        assert!(matches!(
            planning::list(&f.database, &actor, kind, json!({})).await,
            Err(StoreError::Forbidden)
        ));
    }
    let list = planning::list(
        &f.database,
        &member,
        Resource::Label,
        json!({"search":"Label"}),
    )
    .await
    .unwrap();
    assert!(
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"] != private_label.to_string())
    );
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        planning::list(&f.database, &member, Resource::Issue, json!({}))
            .await
            .is_err()
    );
}
