use super::{Fixture, enter_workspace, issue_acceptance::team};
use forge_core::{actor::Actor, saved_views as contract};
use forge_store::{
    StoreError, projects,
    saved_views::{self, ViewOptions},
    team_resources::{self, ResourceOptions},
};
use serde_json::{Value, json};
use uuid::Uuid;
const VIEWS: ViewOptions = ViewOptions { enabled: true };
const RESOURCES: ResourceOptions = ResourceOptions { enabled: true };
fn definition(kind: &str, visibility: &str) -> Value {
    json!({"version":1,"name":"Saved view","description":"Description","icon":null,"visibility":visibility,"kind":kind,"filters":if kind=="projects"{json!([])}else{json!({"match":"all","rules":[]})},"display":if kind=="projects"{contract::default_project_display()}else{forge_core::issue_query::default_display()}})
}
fn create(id: Uuid, definition: Value) -> Value {
    json!({"action":"save","id":id,"expectedRevision":null,"definition":definition})
}
async fn mutate(f: &Fixture, a: &Actor, input: Value) -> Result<Value, StoreError> {
    saved_views::mutate(&f.database, a, &Uuid::new_v4().to_string(), input, VIEWS).await
}
async fn directory(f: &Fixture, a: &Actor) -> Value {
    saved_views::read(&f.database, a, VIEWS).await.unwrap()
}
async fn project(f: &Fixture, teams: &[Uuid], name: &str) -> Uuid {
    let id = Uuid::new_v4();
    projects::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([{"id":id,"expectedRevision":null,"changes":{"name":name,"teamIds":teams}}]),
    )
    .await
    .unwrap();
    id
}
async fn private(f: &Fixture, team: Uuid) {
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
}
fn board(section: Uuid, link: Uuid) -> Value {
    json!({"sections":[{"id":section,"name":"Docs"}],"links":[{"id":link,"title":"Guide","url":" HTTPS://EXAMPLE.test:443/a/../docs ","sectionId":section}],"order":[format!("link:{link}")]})
}

#[tokio::test]
async fn resource_boards_share_normalized_links_order_and_atomic_revision_conflicts() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let (section, link) = (Uuid::new_v4(), Uuid::new_v4());
    assert_eq!(
        team_resources::read(&f.database, &member, team, RESOURCES)
            .await
            .unwrap()["revision"],
        0
    );
    let key = Uuid::new_v4().to_string();
    let input = json!({"teamId":team,"expectedRevision":0,"fields":board(section,link)});
    assert_eq!(
        team_resources::command(&f.database, &member, &key, input.clone(), RESOURCES)
            .await
            .unwrap()["revision"],
        1
    );
    assert_eq!(
        team_resources::command(&f.database, &member, &key, input.clone(), RESOURCES)
            .await
            .unwrap()["revision"],
        1
    );
    let mut changed = input.clone();
    changed["fields"]["sections"][0]["name"] = json!("Changed");
    assert!(matches!(
        team_resources::command(&f.database, &member, &key, changed, RESOURCES).await,
        Err(StoreError::CommandReused)
    ));
    let one = team_resources::read(&f.database, &member, team, RESOURCES)
        .await
        .unwrap();
    assert_eq!(
        one,
        team_resources::read(&f.database, &f.actor, team, RESOURCES)
            .await
            .unwrap()
    );
    assert_eq!(one["links"][0]["url"], "https://example.test/docs");
    let edit = |name: &str| {
        let mut v = input.clone();
        v["expectedRevision"] = json!(1);
        v["fields"]["sections"][0]["name"] = json!(name);
        v
    };
    let (a, b) = (edit("A"), edit("B"));
    let (ka, kb) = (Uuid::new_v4().to_string(), Uuid::new_v4().to_string());
    let (a, b) = tokio::join!(
        team_resources::command(&f.database, &f.actor, &ka, a, RESOURCES),
        team_resources::command(&f.database, &member, &kb, b, RESOURCES)
    );
    assert_eq!(
        usize::from(a.unwrap()["status"] == "saved") + usize::from(b.unwrap()["status"] == "saved"),
        1
    );
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM command_receipts WHERE workspace_id=$1 AND operation='team-resources.write@1'),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='team.resources.updated')").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (2, 2));
}

#[tokio::test]
async fn resources_reject_unsafe_or_dangling_links_and_recheck_source_authority_on_retry() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let input =
        json!({"teamId":team,"expectedRevision":0,"fields":board(Uuid::new_v4(),Uuid::new_v4())});
    for url in [
        "javascript:alert(1)",
        "https://secret:password@example.test",
    ] {
        let mut bad = input.clone();
        bad["fields"]["links"][0]["url"] = json!(url);
        assert!(
            team_resources::command(
                &f.database,
                &member,
                &Uuid::new_v4().to_string(),
                bad,
                RESOURCES
            )
            .await
            .is_err()
        );
    }
    let mut bad = input.clone();
    bad["fields"]["sections"] = json!([]);
    assert!(
        team_resources::command(
            &f.database,
            &member,
            &Uuid::new_v4().to_string(),
            bad,
            RESOURCES
        )
        .await
        .is_err()
    );
    let key = Uuid::new_v4().to_string();
    team_resources::command(&f.database, &member, &key, input.clone(), RESOURCES)
        .await
        .unwrap();
    private(&f, team).await;
    assert!(
        team_resources::command(&f.database, &member, &key, input, RESOURCES)
            .await
            .is_err()
    );
    assert!(
        team_resources::read(&f.database, &member, team, RESOURCES)
            .await
            .is_err()
    );
    let foreign = Fixture::new().await;
    assert!(
        team_resources::read(&f.database, &foreign.actor, team, RESOURCES)
            .await
            .is_err()
    );
    assert!(
        team_resources::read(
            &f.database,
            &f.actor,
            team,
            ResourceOptions { enabled: false }
        )
        .await
        .is_err()
    );
    let external = super::team_key(&f).await;
    assert!(
        team_resources::read(&f.database, &external, team, RESOURCES)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn saved_view_visibility_ownership_favorites_and_privileged_privatization_follow_live_scope()
{
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let (personal, shared) = (Uuid::new_v4(), Uuid::new_v4());
    mutate(
        &f,
        &f.actor,
        create(personal, definition("issues", "personal")),
    )
    .await
    .unwrap();
    mutate(
        &f,
        &member,
        create(shared, definition("issues", "workspace")),
    )
    .await
    .unwrap();
    assert_eq!(
        directory(&f, &member).await["views"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        directory(&f, &f.actor).await["views"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    mutate(
        &f,
        &f.actor,
        json!({"action":"favorite","id":shared,"favorite":true}),
    )
    .await
    .unwrap();
    assert!(
        directory(&f, &f.actor).await["views"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == shared.to_string() && v["favorite"] == true)
    );
    assert_eq!(directory(&f, &member).await["views"][0]["favorite"], false);
    assert!(
        mutate(
            &f,
            &member,
            json!({"action":"delete","id":personal,"expectedRevision":1})
        )
        .await
        .is_err()
    );
    let input = json!({"action":"save","id":shared,"expectedRevision":1,"definition":definition("issues","personal")});
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        saved_views::mutate(&f.database, &f.actor, &key, input.clone(), VIEWS)
            .await
            .unwrap()["value"]["revision"],
        2
    );
    assert!(
        !directory(&f, &f.actor).await["views"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == shared.to_string())
    );
    assert!(
        saved_views::mutate(&f.database, &f.actor, &key, input, VIEWS)
            .await
            .is_err()
    );
    let row = &directory(&f, &member).await["views"][0];
    assert_eq!(row["ownerId"], member.user_id);
    assert_eq!(row["revision"], 2);
    assert_eq!(row["canEdit"], true);
}

#[tokio::test]
async fn saved_view_concurrent_edits_retries_and_soft_delete_do_not_remove_underlying_work() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    let key = Uuid::new_v4().to_string();
    let mut input = create(id, definition("projects", "workspace"));
    input["id"] = json!(id.to_string().to_uppercase());
    let result = saved_views::mutate(&f.database, &f.actor, &key, input.clone(), VIEWS)
        .await
        .unwrap();
    assert_eq!(result["value"]["id"], input["id"]);
    assert_eq!(
        saved_views::mutate(&f.database, &f.actor, &key, input, VIEWS)
            .await
            .unwrap()["replayed"],
        true
    );
    let edit = |name: &str| {
        let mut def = definition("projects", "workspace");
        def["name"] = json!(name);
        json!({"action":"save","id":id,"expectedRevision":1,"definition":def})
    };
    let (a, b) = tokio::join!(
        mutate(&f, &f.actor, edit("A")),
        mutate(&f, &f.actor, edit("B"))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let project = project(&f, &[], "Underlying work").await;
    mutate(
        &f,
        &f.actor,
        json!({"action":"favorite","id":id,"favorite":true}),
    )
    .await
    .unwrap();
    let delete = json!({"action":"delete","id":id,"expectedRevision":2});
    let key = Uuid::new_v4().to_string();
    saved_views::mutate(&f.database, &f.actor, &key, delete.clone(), VIEWS)
        .await
        .unwrap();
    assert_eq!(
        saved_views::mutate(&f.database, &f.actor, &key, delete, VIEWS)
            .await
            .unwrap()["replayed"],
        true
    );
    assert_eq!(directory(&f, &f.actor).await["views"], json!([]));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM saved_view_favorites WHERE view_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    assert!(
        forge_store::planning::get(
            &f.database,
            &f.actor,
            forge_store::planning::Resource::Project,
            project
        )
        .await
        .unwrap()
        .is_object()
    );
    assert!(
        mutate(
            &f,
            &f.actor,
            json!({"action":"favorite","id":id,"favorite":true})
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn lost_filter_references_hide_views_and_refuse_queries_without_widening_results() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let p = project(&f, &[team], "Visible first").await;
    let id = Uuid::new_v4();
    let mut def = definition("projects", "workspace");
    def["filters"] = json!([{"field":"Specific project","value":p}]);
    mutate(&f, &member, create(id, def.clone())).await.unwrap();
    assert_eq!(
        saved_views::query_projects(&f.database, &member, def.clone(), VIEWS)
            .await
            .unwrap()["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    private(&f, team).await;
    assert_eq!(directory(&f, &member).await["views"], json!([]));
    assert!(
        !directory(&f, &member).await["error"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    assert!(
        saved_views::query_projects(&f.database, &member, def, VIEWS)
            .await
            .is_err()
    );
    for value in ["", p.to_string().as_str()] {
        let mut unavailable = definition("projects", "workspace");
        unavailable["filters"] = json!([{"field":"Initiatives","value":value}]);
        assert!(
            mutate(&f, &f.actor, create(Uuid::new_v4(), unavailable.clone()))
                .await
                .is_err()
        );
        assert!(
            saved_views::query_projects(&f.database, &f.actor, unavailable, VIEWS)
                .await
                .is_err()
        );
    }
    let mut issue = definition("issues", "workspace");
    issue["filters"]["rules"] = json!([{"id":"rule","field":"project","operator":"is","value":p}]);
    assert!(
        mutate(&f, &member, create(Uuid::new_v4(), issue))
            .await
            .is_err()
    );
    let mut team_def = definition("issues", "workspace");
    team_def["teamId"] = json!(team);
    assert!(
        mutate(&f, &member, create(Uuid::new_v4(), team_def))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn project_view_projections_filter_authorized_data_and_preserve_authority_metadata() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let public = team(&f, 1).await;
    let hidden = team(&f, 2).await;
    private(&f, hidden).await;
    let a = project(&f, &[public, hidden], "Alpha").await;
    let b = project(&f, &[public], "Beta").await;
    let secret = project(&f, &[hidden], "Secret").await;
    sqlx::query(
        "UPDATE projects SET properties=jsonb_set(properties,'{dependencyIds}',$1) WHERE id=$2",
    )
    .bind(json!([b, secret]))
    .bind(a)
    .execute(&f.pool)
    .await
    .unwrap();
    let mut def = definition("projects", "personal");
    def["filters"] = json!([{"field":"Title & summary","value":"alpha"}]);
    let result = saved_views::query_projects(&f.database, &member, def, VIEWS)
        .await
        .unwrap();
    assert_eq!(result["projects"].as_array().unwrap().len(), 1);
    assert_eq!(result["projects"][0]["id"], a.to_string());
    assert_eq!(result["projects"][0]["teamIds"], json!([public]));
    assert_eq!(result["projects"][0]["dependencyIds"], json!([b]));
    let ids = result["authorizedProjectIds"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&json!(b)));
    assert!(!ids.contains(&json!(secret)));
}

#[tokio::test]
async fn saved_view_team_scope_restricts_workspace_views_and_retries_after_revocation() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let id = Uuid::new_v4();
    let mut def = definition("issues", "workspace");
    def["teamId"] = json!(team);
    let input = create(id, def);
    let key = Uuid::new_v4().to_string();
    saved_views::mutate(&f.database, &member, &key, input.clone(), VIEWS)
        .await
        .unwrap();
    mutate(
        &f,
        &member,
        json!({"action":"favorite","id":id,"favorite":true}),
    )
    .await
    .unwrap();
    private(&f, team).await;
    assert_eq!(directory(&f, &member).await["views"], json!([]));
    assert!(
        saved_views::mutate(&f.database, &member, &key, input, VIEWS)
            .await
            .is_err()
    );
    let foreign = Fixture::new().await;
    assert_eq!(directory(&f, &foreign.actor).await["views"], json!([]));
    assert_eq!(
        saved_views::read(&f.database, &f.actor, ViewOptions::default())
            .await
            .unwrap()["enabled"],
        false
    );
    assert!(
        saved_views::mutate(
            &f.database,
            &f.actor,
            &Uuid::new_v4().to_string(),
            create(Uuid::new_v4(), definition("issues", "workspace")),
            ViewOptions::default()
        )
        .await
        .is_err()
    );
    let external = super::team_key(&f).await;
    assert!(
        saved_views::read(&f.database, &external, VIEWS)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn saved_view_capacity_serializes_concurrent_last_slot_and_project_queries_bound_catalogs() {
    let f = Fixture::new().await;
    let def = definition("projects", "workspace");
    sqlx::query("INSERT INTO saved_views(id,workspace_id,owner_id,visibility,definition,revision) SELECT gen_random_uuid(),$1,$2,'workspace',$3,1 FROM generate_series(1,499)").bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(&def).execute(&f.pool).await.unwrap();
    let (a, b) = tokio::join!(
        mutate(&f, &f.actor, create(Uuid::new_v4(), def.clone())),
        mutate(&f, &f.actor, create(Uuid::new_v4(), def.clone()))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(
        directory(&f, &f.actor).await["views"]
            .as_array()
            .unwrap()
            .len(),
        500
    );
    sqlx::query("INSERT INTO projects(id,workspace_id,name,properties) SELECT gen_random_uuid(),$1,'Project','{}'::jsonb FROM generate_series(1,501)").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        saved_views::query_projects(&f.database, &f.actor, def, VIEWS).await,
        Err(StoreError::Planning(_))
    ));
}

#[tokio::test]
async fn saved_view_project_reference_rechecks_membership_after_waiting_for_resource_lock() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    private(&f, team).await;
    sqlx::query(
        "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
    )
    .bind(&f.actor.workspace_id)
    .bind(team)
    .bind(&member.user_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let project = project(&f, &[team], "Private reference").await;
    let id = Uuid::new_v4();
    let mut def = definition("issues", "workspace");
    def["filters"]["rules"] =
        json!([{"id":"project","field":"project","operator":"is","value":project}]);
    let mut blocker = f.pool.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM projects WHERE id=$1 FOR UPDATE")
        .bind(project)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let writing = mutate(&f, &member, create(id, def));
    let revoke = async {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut blocked = false;
        while tokio::time::Instant::now() < deadline {
            blocked = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(pid)
            .fetch_one(&f.pool)
            .await
            .unwrap();
            if blocked {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        sqlx::query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2")
            .bind(team)
            .bind(&member.user_id)
            .execute(&f.pool)
            .await
            .unwrap();
        blocker.rollback().await.unwrap();
        blocked
    };
    let (result, blocked) = tokio::join!(writing, revoke);
    assert!(blocked);
    assert!(result.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM saved_views WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
