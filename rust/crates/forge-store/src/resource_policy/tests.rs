//! Exercise the actual scoped SQL against the isolated, fully migrated database.
//! Actor activation is a separate gate; these adapters consume an already scoped
//! actor, as they do inside a current-authority command transaction.
use super::*;
use forge_core::actor::{Authentication, LoopScope};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};

struct Fixture {
    pool: PgPool,
    member: Actor,
    scoped: Actor,
    teams: [Uuid; 2],
    issues: [Uuid; 2],
    projects: [Uuid; 4],
    documents: [Uuid; 6],
    loop_id: Uuid,
    run_id: Uuid,
}
impl Fixture {
    async fn new() -> Self {
        let options: sqlx::postgres::PgConnectOptions =
            std::env::var("FORGE_RUST_TEST_DATABASE_URL")
                .expect("Run bun run rewrite:verify with disposable PostgreSQL")
                .parse()
                .unwrap();
        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap();
        let workspace = Uuid::new_v4().to_string();
        let user = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Scope fixture',$1)")
            .bind(&workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO \"user\"(id,name,email) VALUES($1,'Scope member',$2)")
            .bind(&user)
            .bind(format!("{user}@example.test"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&workspace)
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
        let teams = [Uuid::new_v4(), Uuid::new_v4()];
        let issues = [Uuid::new_v4(), Uuid::new_v4()];
        for (n, team) in teams.iter().enumerate() {
            sqlx::query("INSERT INTO teams(id,workspace_id,slug,name,identifier,created_by_user_id,icon_kind,icon_value,color,timezone) VALUES($1,$2,$3,$3,$4,$5,'icon','UserGroup03Icon','#94a3b8','UTC')").bind(team).bind(&workspace).bind(format!("Team {n}")).bind(format!("T{n}")).bind(&user).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title) VALUES($1,$2,$3,1,'Scoped issue')").bind(issues[n]).bind(&workspace).bind(team).execute(&pool).await.unwrap();
        }
        let projects = std::array::from_fn(|_| Uuid::new_v4());
        for (n, project) in projects.iter().enumerate() {
            sqlx::query(
                "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Scoped project')",
            )
            .bind(project)
            .bind(&workspace)
            .execute(&pool)
            .await
            .unwrap();
            let links = match n {
                0 => vec![teams[0]],
                1 => vec![teams[1]],
                2 => vec![],
                _ => teams.to_vec(),
            };
            for team in links {
                sqlx::query(
                    "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
                )
                .bind(&workspace)
                .bind(project)
                .bind(team)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        let documents = std::array::from_fn(|_| Uuid::new_v4());
        for (n, document) in documents.iter().enumerate() {
            sqlx::query("INSERT INTO documents(id,workspace_id,title,team_id,issue_id,project_id,shared_with_workspace) VALUES($1,$2,'Scoped document',$3,$4,$5,$6)")
                .bind(document).bind(&workspace)
                .bind(match n {0=>Some(teams[0]),1|5=>Some(teams[1]),_=>None})
                .bind(if n==2 {Some(issues[0])} else {None})
                .bind(if n==3 {Some(projects[0])} else {None})
                .bind(n==5).execute(&pool).await.unwrap();
        }
        let loop_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        sqlx::query("INSERT INTO team_loops(id,workspace_id,team_id,fields,enabled,enabled_by_id,enabled_at) VALUES($1,$2,$3,'{}',true,$4,clock_timestamp())").bind(loop_id).bind(&workspace).bind(teams[0]).bind(&user).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state) VALUES($1,$2,$3,1,'fixture','fixture','{}','{}',$4,'running')").bind(run_id).bind(&workspace).bind(loop_id).bind(&user).execute(&pool).await.unwrap();
        let member = Actor {
            workspace_id: workspace.clone(),
            user_id: user,
            workspace_role: "member".into(),
            authentication: Authentication::ApiKey {
                credential_id: "resource-fixture".into(),
            },
            scopes: Some(vec![
                ApiScope::IssuesRead,
                ApiScope::TeamsRead,
                ApiScope::ProjectsRead,
            ]),
            loop_scope: None,
        };
        let scoped = Actor {
            workspace_id: workspace,
            user_id: forge_core::loops::principal_id(&loop_id.to_string()),
            workspace_role: "member".into(),
            authentication: Authentication::Loop {
                loop_id: loop_id.to_string(),
                run_id: run_id.to_string(),
            },
            scopes: Some(vec![
                ApiScope::IssuesRead,
                ApiScope::TeamsRead,
                ApiScope::ProjectsRead,
            ]),
            loop_scope: Some(LoopScope {
                loop_id: loop_id.to_string(),
                run_id: run_id.to_string(),
                team_id: teams[0].to_string(),
                all_public: false,
                cancelling: false,
            }),
        };
        Self {
            pool,
            member,
            scoped,
            teams,
            issues,
            projects,
            documents,
            loop_id,
            run_id,
        }
    }
    async fn visible(&self, actor: &Actor, table: &'static str) -> Vec<Uuid> {
        let predicate = match table {
            "teams" => readable_team(actor, "r.id"),
            "issues" => readable_issue(actor, "r.id"),
            "projects" => readable_project(actor, "r.id"),
            "documents" => readable_document(actor, "r.id"),
            _ => panic!("unknown fixture resource"),
        };
        sqlx::query_scalar(&format!(
            "SELECT r.id FROM {table} r WHERE {predicate} ORDER BY r.id"
        ))
        .bind(&actor.workspace_id)
        .bind(privileged(actor))
        .bind(&actor.user_id)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
    async fn private(&self, team: Uuid) {
        sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
            .bind(team)
            .execute(&self.pool)
            .await
            .unwrap();
    }
}
fn sorted(ids: &[Uuid]) -> Vec<Uuid> {
    let mut ids = ids.to_vec();
    ids.sort();
    ids
}

#[tokio::test]
async fn loops_read_their_private_team_without_membership_and_cannot_inherit_other_access() {
    let f = Fixture::new().await;
    f.private(f.teams[0]).await;
    assert_eq!(f.visible(&f.scoped, "teams").await, vec![f.teams[0]]);
    assert_eq!(f.visible(&f.scoped, "issues").await, vec![f.issues[0]]);
    let mut connection = f.pool.acquire().await.unwrap();
    team(&mut connection, &f.scoped, f.teams[0]).await.unwrap();
    assert!(matches!(
        team(&mut connection, &f.scoped, f.teams[1]).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(
        team_ids(&mut connection, &f.scoped).await.unwrap(),
        vec![f.teams[0]]
    );
    let mut scoped = f.scoped.clone();
    scoped.scopes = Some(vec![ApiScope::IssuesRead]);
    assert_eq!(
        issue(&mut connection, &scoped, f.issues[0], true)
            .await
            .unwrap()
            .id,
        f.issues[0]
    );
    assert!(matches!(
        issue(&mut connection, &scoped, f.issues[1], false).await,
        Err(StoreError::Forbidden)
    ));
    // A synthetic principal accidentally added to a different team still cannot
    // escape its scope, even if an upstream caller supplies an administrative role.
    sqlx::query("INSERT INTO \"user\"(id,name,email) VALUES($1,'Loop',$2)")
        .bind(&scoped.user_id)
        .bind(format!("{}@example.test", f.loop_id))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')")
        .bind(Uuid::new_v4().to_string())
        .bind(&scoped.workspace_id)
        .bind(&scoped.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(&scoped.workspace_id)
        .bind(f.teams[1])
        .bind(&scoped.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    scoped.workspace_role = "owner,admin".into();
    assert!(!privileged(&scoped));
    assert_eq!(f.visible(&scoped, "teams").await, vec![f.teams[0]]);
    // A resolved broad scope is only issued while its owning team is public.
    sqlx::query("UPDATE teams SET visibility='workspace' WHERE id=$1")
        .bind(f.teams[0])
        .execute(&f.pool)
        .await
        .unwrap();
    scoped.loop_scope.as_mut().unwrap().all_public = true;
    assert_eq!(f.visible(&scoped, "teams").await, sorted(&f.teams));
    f.private(f.teams[1]).await;
    assert_eq!(f.visible(&scoped, "teams").await, vec![f.teams[0]]);
}

#[tokio::test]
async fn projects_and_documents_apply_scope_to_every_source_and_workspace_sharing() {
    let f = Fixture::new().await;
    f.private(f.teams[1]).await;
    assert_eq!(
        f.visible(&f.scoped, "projects").await,
        sorted(&[f.projects[0], f.projects[3]])
    );
    assert_eq!(
        f.visible(&f.scoped, "documents").await,
        sorted(&[f.documents[0], f.documents[2], f.documents[3]])
    );
    let mut broad = f.scoped.clone();
    broad.loop_scope.as_mut().unwrap().all_public = true;
    assert_eq!(
        f.visible(&broad, "projects").await,
        sorted(&[f.projects[0], f.projects[2], f.projects[3]])
    );
    assert_eq!(
        f.visible(&broad, "documents").await,
        sorted(&[
            f.documents[0],
            f.documents[2],
            f.documents[3],
            f.documents[4],
            f.documents[5]
        ])
    );
    // Archived/deleted issues remain inaccessible through attached documents;
    // retained issue reads can still find their non-purged history.
    sqlx::query("UPDATE issues SET archived_at=clock_timestamp() WHERE id=$1")
        .bind(f.issues[0])
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f.visible(&f.scoped, "issues").await.is_empty());
    assert!(
        !f.visible(&f.scoped, "documents")
            .await
            .contains(&f.documents[2])
    );
    let retained: bool = sqlx::query_scalar(&format!("SELECT {}", retained_issue(&f.scoped, "$4")))
        .bind(&f.scoped.workspace_id)
        .bind(false)
        .bind(&f.scoped.user_id)
        .bind(f.issues[0])
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(retained);
    sqlx::query("UPDATE documents SET deleted_at=clock_timestamp() WHERE id=$1")
        .bind(f.documents[5])
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        !f.visible(&broad, "documents")
            .await
            .contains(&f.documents[5])
    );
}

#[tokio::test]
async fn disabled_deleted_or_terminal_loops_lose_even_workspace_wide_resource_access() {
    let f = Fixture::new().await;
    let mut broad = f.scoped.clone();
    broad.loop_scope.as_mut().unwrap().all_public = true;
    for state in [
        "queued",
        "completed",
        "failed",
        "cancelled",
        "blocked",
        "uncertain",
        "running",
        "waiting-for-approval",
    ] {
        sqlx::query("UPDATE loop_runs SET state=$2 WHERE id=$1")
            .bind(f.run_id)
            .bind(state)
            .execute(&f.pool)
            .await
            .unwrap();
        for table in ["teams", "issues", "projects", "documents"] {
            assert_eq!(
                !f.visible(&broad, table).await.is_empty(),
                matches!(state, "running" | "waiting-for-approval"),
                "{state}/{table}"
            );
        }
    }
    for (enabled, deleted) in [(false, false), (true, true), (true, false)] {
        sqlx::query("UPDATE team_loops SET enabled=$2,deleted_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE id=$1").bind(f.loop_id).bind(enabled).bind(deleted).execute(&f.pool).await.unwrap();
        for table in ["teams", "issues", "projects", "documents"] {
            assert_eq!(
                !f.visible(&broad, table).await.is_empty(),
                enabled && !deleted
            );
        }
    }
    // A valid run cannot be presented in a different workspace.
    let other = Fixture::new().await;
    broad.workspace_id = other.member.workspace_id.clone();
    for table in ["teams", "issues", "projects", "documents"] {
        assert!(f.visible(&broad, table).await.is_empty());
    }
}

#[tokio::test]
async fn malformed_loop_scope_fails_closed_with_typed_parameters_and_no_sql_interpolation() {
    let f = Fixture::new().await;
    for key in ["loopId", "runId", "teamId"] {
        for invalid in ["not-a-uuid", "' OR true --", ""] {
            let mut serialized = serde_json::to_value(&f.scoped).unwrap();
            serialized["loopScope"][key] = json!(invalid);
            serialized["loopScope"]["allPublic"] = json!(true);
            let actor: Actor = serde_json::from_value(serialized).unwrap();
            for table in ["teams", "issues", "projects", "documents"] {
                assert!(f.visible(&actor, table).await.is_empty(), "{key}/{table}");
            }
        }
    }
}

#[tokio::test]
async fn ordinary_membership_private_access_and_archive_visibility_remain_live() {
    let f = Fixture::new().await;
    f.private(f.teams[1]).await;
    assert_eq!(f.visible(&f.member, "teams").await, vec![f.teams[0]]);
    let mut admin = f.member.clone();
    sqlx::query("UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.member.workspace_id)
        .bind(&f.member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    admin.workspace_role = "admin".into();
    assert_eq!(f.visible(&admin, "teams").await, sorted(&f.teams));
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.member.workspace_id)
        .bind(&f.member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(&f.member.workspace_id)
        .bind(f.teams[1])
        .bind(&f.member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(f.visible(&f.member, "teams").await, sorted(&f.teams));
    sqlx::query("UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1")
        .bind(f.teams[1])
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(f.visible(&f.member, "teams").await, vec![f.teams[0]]);
    let query = format!(
        "SELECT t.id FROM teams t WHERE {} ORDER BY t.id",
        readable_team_including_archived(&f.member, "t.id", true)
    );
    let ids: Vec<Uuid> = sqlx::query_scalar(&query)
        .bind(&f.member.workspace_id)
        .bind(false)
        .bind(&f.member.user_id)
        .fetch_all(&f.pool)
        .await
        .unwrap();
    assert_eq!(ids, sorted(&f.teams));
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.member.workspace_id)
        .bind(&f.member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for table in ["teams", "issues", "projects", "documents"] {
        assert!(f.visible(&admin, table).await.is_empty());
    }
}

#[tokio::test]
async fn shared_directories_label_counts_and_project_team_projections_keep_loop_scope() {
    let f = Fixture::new().await;
    let label = Uuid::new_v4();
    sqlx::query("INSERT INTO resource_labels(id,workspace_id,name) VALUES($1,$2,'Shared label')")
        .bind(label)
        .bind(&f.member.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for id in f.issues {
        sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
            .bind(&f.member.workspace_id)
            .bind(id)
            .bind(label)
            .execute(&f.pool)
            .await
            .unwrap();
    }
    let mut c = f.pool.acquire().await.unwrap();
    let directory = crate::teams::directory_in(&mut c, &f.scoped, false)
        .await
        .unwrap();
    let teams = directory["items"].as_array().unwrap();
    assert_eq!(teams.len(), 1);
    assert_eq!(teams[0]["id"], f.teams[0].to_string());
    let definitions = crate::definitions::read_tx(&mut c, &f.scoped, None)
        .await
        .unwrap();
    let labels: Value = serde_json::to_value(definitions.value).unwrap();
    assert_eq!(labels["labels"]["labels"][0]["issues"], 1);
    let projects = crate::projects::snapshot(&mut c, &f.scoped, None)
        .await
        .unwrap();
    assert_eq!(projects.len(), 2);
    assert!(projects.iter().all(|p| p["teamIds"] == json!([f.teams[0]])));
}
