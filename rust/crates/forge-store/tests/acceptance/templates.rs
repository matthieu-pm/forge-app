use super::{Fixture, enter_workspace, team_input};
use forge_core::templates as contract;
use forge_store::{StoreError, teams, templates as t};
use serde_json::{Value, json};
use uuid::Uuid;
fn payload(name: &str, team: Option<&str>) -> Value {
    let mut v = contract::empty("issue", team);
    v["name"] = json!(name);
    v
}
async fn row(f: &Fixture, slug: Option<&str>, id: &Value, recurring: bool) -> Value {
    let input = slug.map_or(json!({}), |s| json!({"slug":s}));
    let v = t::read(&f.database, &f.actor, input, recurring)
        .await
        .unwrap();
    let a = if recurring { &v } else { &v["templates"] };
    a.as_array()
        .unwrap()
        .iter()
        .find(|r| &r["id"] == id)
        .unwrap()
        .clone()
}
#[tokio::test]
async fn templates_serialize_names_revisions_and_default_eligibility() {
    let f = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(51))
        .await
        .unwrap();
    let p = payload(" Bug report ", Some(&team.id.to_string()));
    let input = json!({"slug":team.slug,"payload":p});
    let (a, b) = tokio::join!(
        t::save(&f.database, &f.actor, input.clone(), false),
        t::save(&f.database, &f.actor, input.clone(), false)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let saved = a.or(b).unwrap();
    let id = &saved["id"];
    let loaded = row(&f, Some(&team.slug), id, false).await;
    assert_eq!(loaded["payload"]["name"], "Bug report");
    assert_eq!(loaded["createdBy"], "Original Actor");
    let mut duplicate = p.clone();
    duplicate["name"] = json!("bUg REPORT");
    assert!(matches!(
        t::save(
            &f.database,
            &f.actor,
            json!({"slug":team.slug,"payload":duplicate}),
            false
        )
        .await,
        Err(StoreError::Template(_))
    ));
    t::set_default(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"audience":"members","templateId":id}),
    )
    .await
    .unwrap();
    assert_eq!(
        t::read(&f.database, &f.actor, json!({"slug":team.slug}), false)
            .await
            .unwrap()["defaults"]["members"],
        *id
    );
    sqlx::query("UPDATE team_templates SET updated_at='2099-01-01T00:00:00Z' WHERE id=$1")
        .bind(Uuid::parse_str(id.as_str().unwrap()).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    let old = row(&f, Some(&team.slug), id, false).await;
    let mut edit = json!({"slug":team.slug,"id":id,"updatedAt":old["updatedAt"],"payload":p});
    let mut changed = edit.clone();
    changed["payload"]["title"] = json!("Changed");
    let (a, b) = tokio::join!(
        t::save(&f.database, &f.actor, edit.clone(), false),
        t::save(&f.database, &f.actor, changed, false)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(
        a.err().or(b.err()),
        Some(StoreError::TemplateConflict)
    ));
    let current = row(&f, Some(&team.slug), id, false).await;
    assert_eq!(current["updatedAt"], "2099-01-01T00:00:00.001Z");
    edit["updatedAt"] = current["updatedAt"].clone();
    edit["payload"]["kind"] = json!("project");
    assert!(matches!(
        t::save(&f.database, &f.actor, edit.clone(), false).await,
        Err(StoreError::Template(_))
    ));
    edit["payload"]["kind"] = json!("issue");
    edit["payload"]["issueType"] = json!("form");
    t::save(&f.database, &f.actor, edit, false).await.unwrap();
    assert!(
        t::set_default(
            &f.database,
            &f.actor,
            json!({"slug":team.slug,"audience":"members","templateId":id})
        )
        .await
        .is_err()
    );
    t::set_default(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"audience":"nonMembers","templateId":id}),
    )
    .await
    .unwrap();
    t::delete(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"id":id}),
        false,
    )
    .await
    .unwrap();
    let directory = t::read(&f.database, &f.actor, json!({"slug":team.slug}), false)
        .await
        .unwrap();
    assert_eq!(
        directory["defaults"],
        json!({"members":null,"nonMembers":null})
    );
    t::delete(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"id":id}),
        false,
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn templates_recheck_team_visibility_members_and_live_authority() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let foreign = Fixture::new().await;
    let public = teams::create(&f.database, &f.actor, &team_input(61))
        .await
        .unwrap();
    let private = teams::create(&f.database, &f.actor, &team_input(62))
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let member = enter_workspace(&f, &visitor).await;
    let mut p = payload("Private visibility", Some(&public.id.to_string()));
    p["visibility"] = json!(private.id);
    let saved = t::save(
        &f.database,
        &f.actor,
        json!({"slug":public.slug,"payload":p}),
        false,
    )
    .await
    .unwrap();
    assert!(
        t::read(&f.database, &member, json!({"slug":private.slug}), false)
            .await
            .is_err()
    );
    let dir = t::read(&f.database, &member, json!({"slug":public.slug}), false)
        .await
        .unwrap();
    assert_eq!(dir["templates"], json!([]));
    assert_eq!(dir["canManage"], false);
    assert!(
        t::delete(
            &f.database,
            &member,
            json!({"slug":public.slug,"id":saved["id"]}),
            false
        )
        .await
        .is_err()
    );
    assert!(
        t::save(
            &foreign.database,
            &foreign.actor,
            json!({"slug":public.slug,"payload":p}),
            false
        )
        .await
        .is_err()
    );
    p["properties"]["assignee"] = json!(foreign.actor.user_id);
    assert!(
        t::save(
            &f.database,
            &f.actor,
            json!({"slug":public.slug,"payload":p}),
            false
        )
        .await
        .is_err()
    );
    let mut workspace = payload("Workspace", None);
    t::save(&f.database, &f.actor, json!({"payload":workspace}), false)
        .await
        .unwrap();
    workspace["kind"] = json!("document");
    assert!(
        t::save(&f.database, &f.actor, json!({"payload":workspace}), false)
            .await
            .is_err()
    );
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        t::delete(
            &f.database,
            &f.actor,
            json!({"slug":public.slug,"id":saved["id"]}),
            false
        )
        .await
        .is_err()
    );
    assert_eq!(
        row(&f, Some(&public.slug), &saved["id"], false).await["id"],
        saved["id"]
    );
}
#[tokio::test]
async fn recurring_definitions_preserve_team_scope_and_reject_stale_saves_and_deletes() {
    let f = Fixture::new().await;
    let team = teams::create(&f.database, &f.actor, &team_input(71))
        .await
        .unwrap();
    let mut p = contract::empty_recurring(
        &team.id.to_string(),
        "Pacific/Kiritimati",
        "2026-12-31T12:00:00Z".parse().unwrap(),
    )
    .unwrap();
    p["title"] = json!(" Weekly review ");
    let saved = t::save(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"payload":p}),
        true,
    )
    .await
    .unwrap();
    let id = &saved["id"];
    let original = row(&f, Some(&team.slug), id, true).await;
    assert_eq!(original["payload"]["firstDue"], "2027-01-08");
    assert_eq!(original["payload"]["title"], "Weekly review");
    assert!(original.get("createdBy").is_none());
    let edit = json!({"slug":team.slug,"id":id,"updatedAt":original["updatedAt"],"payload":p});
    t::save(&f.database, &f.actor, edit.clone(), true)
        .await
        .unwrap();
    assert!(matches!(
        t::save(&f.database, &f.actor, edit, true).await,
        Err(StoreError::TemplateConflict)
    ));
    assert!(matches!(
        t::delete(
            &f.database,
            &f.actor,
            json!({"slug":team.slug,"id":id,"updatedAt":original["updatedAt"]}),
            true
        )
        .await,
        Err(StoreError::TemplateConflict)
    ));
    let current = row(&f, Some(&team.slug), id, true).await;
    p["properties"]["teamIds"] = json!([]);
    assert!(
        t::save(
            &f.database,
            &f.actor,
            json!({"slug":team.slug,"payload":p}),
            true
        )
        .await
        .is_err()
    );
    t::delete(
        &f.database,
        &f.actor,
        json!({"slug":team.slug,"id":id,"updatedAt":current["updatedAt"]}),
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        t::read(&f.database, &f.actor, json!({"slug":team.slug}), true)
            .await
            .unwrap(),
        json!([])
    );
}
