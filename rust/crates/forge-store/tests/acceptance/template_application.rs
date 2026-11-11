use super::{Fixture, enter_workspace, team_input};
use forge_core::{actor::Actor, templates as contract};
use forge_store::{
    StoreError, initiatives, projects, teams, template_application as app, templates,
};
use serde_json::{Value, json};
use uuid::Uuid;
#[derive(sqlx::FromRow)]
struct IssueRow {
    title: String,
    status_id: String,
    assignee_id: Option<String>,
    parent_id: Option<Uuid>,
    properties: Value,
}
fn options() -> app::Options {
    app::Options {
        enabled: true,
        initiatives: initiatives::InitiativeOptions { enabled: true },
        ..Default::default()
    }
}
fn uid(v: &Value) -> Uuid {
    v.as_str().unwrap().parse().unwrap()
}
fn payload(kind: &str, team: Uuid) -> Value {
    let mut p = contract::empty(kind, Some(&team.to_string()));
    p["name"] = json!(Uuid::new_v4().to_string());
    p["title"] = json!("Template title");
    p["visibility"] = json!("");
    p
}
async fn select(f: &Fixture, template: &Value, slug: Option<&str>) -> Value {
    let directory = app::directory(
        &f.database,
        &f.actor,
        slug.map_or(json!({}), |s| json!({"slug":s})),
        options(),
    )
    .await
    .unwrap();
    let row = directory["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == *template)
        .unwrap();
    json!({"commandKey":Uuid::new_v4(),"templateId":template,"revision":row["revision"]})
}
async fn save(f: &Fixture, p: Value, slug: Option<&str>) -> Value {
    let mut input = json!({"payload":p});
    if let Some(slug) = slug {
        input["slug"] = json!(slug);
    }
    let saved = templates::save(&f.database, &f.actor, input, false)
        .await
        .unwrap();
    select(f, &saved["id"], slug).await
}
async fn apply(f: &Fixture, a: &Actor, input: &Value) -> Value {
    app::apply(&f.database, a, input.clone(), options())
        .await
        .unwrap()
}
async fn counts(f: &Fixture) -> (i64, i64, i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM issues WHERE workspace_id=$1),(SELECT count(*) FROM projects WHERE workspace_id=$1),(SELECT count(*) FROM command_receipts WHERE workspace_id=$1 AND operation='templates.apply@1'),(SELECT count(*) FROM command_audit_events WHERE workspace_id=$1 AND operation='templates.apply@1'),(SELECT count(*) FROM command_outbox_events e JOIN command_receipts r ON r.id=e.command_id WHERE r.workspace_id=$1 AND r.operation='templates.apply@1')").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap()
}
async fn project(f: &Fixture, name: &str, teams: &[Uuid]) -> Uuid {
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
async fn replace_raw(f: &Fixture, input: &Value, p: &Value) -> Value {
    sqlx::query("UPDATE team_templates SET payload=$2 WHERE id=$1")
        .bind(uid(&input["templateId"]))
        .bind(p)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut next = select(f, &input["templateId"], None).await;
    next["commandKey"] = input["commandKey"].clone();
    next
}

#[tokio::test]
async fn exact_retries_create_one_canonical_tree_with_one_receipt_and_attributed_events() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = teams::create(&f.database, &f.actor, &team_input(61))
        .await
        .unwrap();
    let label: Uuid = sqlx::query_scalar(
        "INSERT INTO resource_labels(workspace_id,team_id,name) VALUES($1,$2,'Bug') RETURNING id",
    )
    .bind(&f.actor.workspace_id)
    .bind(team.id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let mut p = payload("issue", team.id);
    p["content"] = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Reusable body"}]}]});
    p["properties"]["assignee"] = json!(member.user_id);
    p["properties"]["priority"] = json!("High");
    p["properties"]["estimate"] = json!("3");
    p["properties"]["labels"] = json!([label]);
    let mut child = contract::empty_properties(Some(&team.id.to_string()));
    child["status"] = json!("todo");
    child["priority"] = json!("Low");
    p["subIssues"] = json!([{"id":"old","title":"Investigate","content":null,"properties":child}]);
    let mut input = save(&f, p, None).await;
    input["title"] = json!("  Custom title  ");
    let (one, two) = tokio::join!(apply(&f, &member, &input), apply(&f, &member, &input));
    assert_eq!(one["ok"], true, "{one}");
    assert_eq!(two["ok"], true, "{two}");
    assert_eq!(one["value"], two["value"]);
    assert_ne!(one["replayed"], two["replayed"]);
    assert!(one["value"].get("initiativeIds").is_none());
    let rows:Vec<IssueRow>=sqlx::query_as("SELECT title,status_id,assignee_id,parent_id,properties FROM issues WHERE workspace_id=$1 ORDER BY number").bind(&f.actor.workspace_id).fetch_all(&f.pool).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].title, "Custom title");
    assert_eq!(rows[0].status_id, "backlog");
    assert_eq!(
        rows[0].assignee_id.as_deref(),
        Some(member.user_id.as_str())
    );
    assert_eq!(rows[0].properties["priority"], "High");
    assert_eq!(rows[0].properties["description"], "Reusable body");
    assert_eq!(rows[0].properties["estimate"], "3");
    assert_eq!(rows[0].properties["labels"], "Bug");
    assert_eq!(rows[1].title, "Investigate");
    assert_eq!(rows[1].status_id, "todo");
    assert_eq!(rows[1].parent_id, Some(uid(&one["value"]["id"])));
    assert_eq!(rows[1].properties["priority"], "Low");
    assert_eq!(counts(&f).await, (2, 0, 1, 1, 2));
    let mut changed = input.clone();
    changed["title"] = json!("Changed");
    assert!(matches!(
        app::apply(&f.database, &member, changed, options()).await,
        Err(StoreError::CommandReused)
    ));
    input["commandKey"] = json!(Uuid::new_v4());
    let fresh = apply(&f, &member, &input).await;
    assert_eq!(fresh["ok"], true);
    assert_ne!(fresh["value"]["id"], one["value"]["id"]);
    assert_eq!(counts(&f).await, (4, 0, 2, 2, 4));
}

#[tokio::test]
async fn project_application_composes_milestones_dependencies_initiatives_and_nested_issues() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = teams::create(&f.database, &f.actor, &team_input(62))
        .await
        .unwrap();
    let hidden = teams::create(&f.database, &f.actor, &team_input(63))
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(hidden.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let blocker = project(&f, "Blocker", &[team.id]).await;
    let blocked = project(&f, "Blocked", &[team.id]).await;
    let secret = project(&f, "Hidden", &[hidden.id]).await;
    let revision: i32 = sqlx::query_scalar("SELECT revision FROM projects WHERE id=$1")
        .bind(blocked)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    projects::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([{"id":blocked,"expectedRevision":revision,"changes":{"dependencyIds":[secret]}}]),
    )
    .await
    .unwrap();
    let goal = Uuid::new_v4();
    initiatives::save(&f.database,&f.actor,&Uuid::new_v4().to_string(),json!([{"id":goal,"expectedRevision":null,"changes":{"name":"Launch goal"},"addProjectIds":[]}]),options().initiatives).await.unwrap();
    let mut p = payload("project", team.id);
    p["title"] = json!("Launch");
    p["summary"] = json!("Ready to ship");
    p["properties"]["lead"] = json!(member.user_id);
    p["properties"]["members"] = json!([f.actor.user_id]);
    p["properties"]["dependencies"] =
        json!([{"direction":"blockedBy","name":blocker},{"direction":"blocking","name":"Blocked"}]);
    p["properties"]["initiatives"] = json!([goal]);
    p["milestones"] = json!([{"id":"old","title":"Ship","content":null}]);
    p["issues"] = json!([{"id":"old","title":"Prepare","content":null,"properties":contract::empty_properties(Some(&team.id.to_string()))}]);
    let input = save(&f, p, None).await;
    let result = apply(&f, &member, &input).await;
    assert_eq!(result["ok"], true, "{result}");
    let id = uid(&result["value"]["id"]);
    assert_eq!(result["value"]["projectIds"], json!([id, blocked]));
    let properties: Value = sqlx::query_scalar("SELECT properties FROM projects WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(properties["summary"], "Ready to ship");
    assert_eq!(properties["leadId"], member.user_id);
    assert_eq!(properties["memberIds"], json!([f.actor.user_id]));
    assert_eq!(properties["dependencyIds"], json!([blocker]));
    assert_eq!(properties["milestones"][0]["name"], "Ship");
    assert_eq!(properties["milestones"][0]["completed"], false);
    assert_ne!(properties["milestones"][0]["id"], "old");
    assert!(Uuid::parse_str(properties["milestones"][0]["id"].as_str().unwrap()).is_ok());
    let deps: Value =
        sqlx::query_scalar("SELECT properties->'dependencyIds' FROM projects WHERE id=$1")
            .bind(blocked)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(deps.as_array().unwrap().contains(&json!(secret)));
    assert!(deps.as_array().unwrap().contains(&json!(id)));
    let linked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM initiative_projects WHERE initiative_id=$1 AND project_id=$2",
    )
    .bind(goal)
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(linked, 1);
    let parent: Uuid = sqlx::query_scalar("SELECT project_id FROM issues WHERE id=$1")
        .bind(uid(&result["value"]["issueIds"][0]))
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(parent, id);
    let retry = apply(&f, &member, &input).await;
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["value"], result["value"]);
    let references = app::references(&f.database, &member, options())
        .await
        .unwrap();
    assert!(
        !references["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == secret.to_string())
    );
    assert_eq!(references["initiatives"][0]["id"], goal.to_string());
    let mut disabled = options();
    disabled.initiatives.enabled = false;
    assert!(matches!(
        app::apply(&f.database, &member, input, disabled).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn bad_nested_references_cycles_and_disabled_initiatives_rollback_every_effect() {
    let f = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(64))
        .await
        .unwrap();
    let existing = project(&f, "Existing", &[team.id]).await;
    let goal = Uuid::new_v4();
    initiatives::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([{"id":goal,"expectedRevision":null,"changes":{"name":"Goal"},"addProjectIds":[]}]),
        options().initiatives,
    )
    .await
    .unwrap();
    for kind in 0..3 {
        let mut p = payload("project", team.id);
        if kind == 0 {
            let mut props = contract::empty_properties(Some(&team.id.to_string()));
            props["status"] = json!("canceled");
            p["issues"] =
                json!([{"id":"child","title":"Broken","content":null,"properties":props}]);
        }
        if kind == 1 {
            p["properties"]["dependencies"] = json!([{"direction":"blockedBy","name":existing},{"direction":"blocking","name":existing}]);
        }
        if kind == 2 {
            p["properties"]["initiatives"] = json!([goal]);
        }
        let input = save(&f, p, None).await;
        if kind == 0 {
            // A valid saved template can outlive its status. Keep the original
            // template-definition constraint active during fixture creation.
            sqlx::query("DELETE FROM issue_statuses WHERE team_id=$1 AND id='canceled'")
                .bind(team.id)
                .execute(&f.pool)
                .await
                .unwrap();
        }
        let mut opts = options();
        if kind == 2 {
            opts.initiatives.enabled = false;
        }
        let result = app::apply(&f.database, &f.actor, input, opts)
            .await
            .unwrap();
        assert_eq!(result["ok"], false, "case {kind}: {result}");
        assert_eq!(result["code"], "TEMPLATE_VALIDATION");
        assert_eq!(counts(&f).await, (0, 1, 0, 0, 0));
    }
}

#[tokio::test]
async fn forms_validate_all_fields_and_failed_answers_can_reuse_the_rolled_back_key() {
    let f = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(65))
        .await
        .unwrap();
    let mut p = payload("issue", team.id);
    p["issueType"] = json!("form");
    p["fields"] = json!(
        ["text", "textarea", "select", "checkbox", "date", "number"].map(
            |kind| json!({"id":kind,"label":kind,"type":kind,"required":true,"options":["A","B"]})
        )
    );
    let mut input = save(&f, p, None).await;
    assert_eq!(apply(&f, &f.actor, &input).await["ok"], false);
    let answers = json!({"text":"Hello","textarea":"Details","select":"A","checkbox":true,"date":"2028-02-29","number":7});
    for change in [
        json!({"select":"C"}),
        json!({"checkbox":false}),
        json!({"date":"2026-02-30"}),
        json!({"number":"NaN"}),
        json!({"extra":"Injected"}),
    ] {
        let mut next = answers.clone();
        next.as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        input["answers"] = next;
        assert_eq!(apply(&f, &f.actor, &input).await["ok"], false);
    }
    assert_eq!(counts(&f).await, (0, 0, 0, 0, 0));
    input["answers"] = answers;
    let result = apply(&f, &f.actor, &input).await;
    assert_eq!(result["ok"], true, "{result}");
    let p: Value = sqlx::query_scalar("SELECT properties FROM issues WHERE id=$1")
        .bind(uid(&result["value"]["id"]))
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(p["descriptionDoc"]["content"].as_array().unwrap().len(), 12);
    assert_eq!(
        p["description"],
        "text\nHello\ntextarea\nDetails\nselect\nA\ncheckbox\nYes\ndate\n2028-02-29\nnumber\n7"
    );
}

#[tokio::test]
async fn reviewed_revisions_replay_current_authority_and_deleted_templates_preserve_identity() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = teams::create(&f.database, &f.actor, &team_input(66))
        .await
        .unwrap();
    let mut p = payload("issue", team.id);
    let input = save(&f, p.clone(), None).await;
    p["title"] = json!("Latest");
    let repaired = replace_raw(&f, &input, &p).await;
    let stale = apply(&f, &member, &input).await;
    assert_eq!(stale["ok"], false);
    assert!(stale["message"].as_str().unwrap().contains("changed"));
    assert_eq!(counts(&f).await, (0, 0, 0, 0, 0));
    let saved = apply(&f, &member, &repaired).await;
    assert_eq!(saved["ok"], true, "{saved}");
    p["title"] = json!("Changed again");
    replace_raw(&f, &input, &p).await;
    assert_eq!(apply(&f, &member, &repaired).await["replayed"], true);
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        app::apply(&f.database, &member, repaired.clone(), options()).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE teams SET visibility='workspace' WHERE id=$1")
        .bind(team.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(apply(&f, &member, &repaired).await["replayed"], true);
    templates::delete(
        &f.database,
        &f.actor,
        json!({"id":input["templateId"]}),
        false,
    )
    .await
    .unwrap();
    assert!(matches!(
        app::apply(&f.database, &member, repaired, options()).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(counts(&f).await, (1, 0, 1, 1, 1));
}

#[tokio::test]
async fn directories_defaults_private_scope_and_live_membership_are_enforced() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let other = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(67))
        .await
        .unwrap();
    let private = teams::create(&f.database, &f.actor, &team_input(68))
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut standard = payload("issue", team.id);
    standard["visibility"] = json!(team.id);
    let first = save(&f, standard.clone(), Some(&team.slug)).await;
    standard["name"] = json!("Form default");
    standard["issueType"] = json!("form");
    let second = save(&f, standard, Some(&team.slug)).await;
    for (audience, template) in [("members", &first), ("nonMembers", &second)] {
        templates::set_default(
            &f.database,
            &f.actor,
            json!({"slug":team.slug,"audience":audience,"templateId":template["templateId"]}),
        )
        .await
        .unwrap();
    }
    let own = app::directory(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"kind":"issue"}),
        options(),
    )
    .await
    .unwrap();
    assert_eq!(own["defaultId"], first["templateId"]);
    let visit = app::directory(&f.database, &member, json!({"slug":team.slug}), options())
        .await
        .unwrap();
    assert_eq!(visit["defaultId"], second["templateId"]);
    assert!(
        app::directory(
            &f.database,
            &member,
            json!({"slug":team.slug,"kind":"project"}),
            options()
        )
        .await
        .unwrap()["defaultId"]
            .is_null()
    );
    let mut hidden = payload("issue", private.id);
    hidden["visibility"] = json!(private.id);
    let input = save(&f, hidden, Some(&private.slug)).await;
    assert_eq!(apply(&f, &member, &input).await["ok"], false);
    assert_eq!(apply(&f, &other.actor, &input).await["ok"], false);
    assert!(matches!(
        app::directory(
            &f.database,
            &member,
            json!({"slug":private.slug}),
            options()
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let off = app::Options::default();
    assert_eq!(
        app::directory(&f.database, &member, json!({}), off)
            .await
            .unwrap(),
        json!({"enabled":false,"templates":[],"teams":[],"defaultId":null})
    );
    assert!(matches!(
        app::apply(&f.database, &member, first.clone(), off).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        app::apply(&f.database, &member, first, options())
            .await
            .is_err()
    );
    assert_eq!(counts(&f).await, (0, 0, 0, 0, 0));
}

#[tokio::test]
async fn deferred_commit_failure_is_not_repairable_validation_and_original_key_retries() {
    let f = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(69))
        .await
        .unwrap();
    let input = save(&f, payload("issue", team.id), None).await;
    let name = format!("template_commit_fault_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{}' THEN RAISE EXCEPTION 'injected template commit failure'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER {name} AFTER INSERT ON command_audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {name}()",f.actor.workspace_id)).execute(&f.pool).await.unwrap();
    let result = app::apply(&f.database, &f.actor, input.clone(), options()).await;
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {name} ON command_audit_events; DROP FUNCTION {name}()"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(matches!(result, Err(StoreError::Database(_))), "{result:?}");
    assert_eq!(counts(&f).await, (0, 0, 0, 0, 0));
    let result = apply(&f, &f.actor, &input).await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["replayed"], false);
    assert_eq!(apply(&f, &f.actor, &input).await["replayed"], true);
    assert_eq!(counts(&f).await, (1, 0, 1, 1, 1));
}
