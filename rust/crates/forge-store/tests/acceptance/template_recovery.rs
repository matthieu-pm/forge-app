use super::*;
use serde_json::json;

#[tokio::test]
async fn template_application_requires_preparation_and_retries_the_same_uncommitted_identity() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Template application recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Recovery","identifier":"RCV","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let mut payload = forge_core::templates::empty("issue", Some(&team.id.to_string()));
    payload["name"] = json!("Recovery template");
    payload["title"] = json!("Recovered issue");
    payload["visibility"] = json!("");
    let saved =
        forge_store::templates::save(&f.database, &actor, json!({"payload":payload}), false)
            .await
            .unwrap();
    let options = forge_store::template_application::Options {
        enabled: true,
        ..Default::default()
    };
    let directory =
        forge_store::template_application::directory(&f.database, &actor, json!({}), options)
            .await
            .unwrap();
    let input = json!({"templateId":saved["id"],"commandKey":Uuid::new_v4(),"revision":directory["templates"][0]["revision"]});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        forge_store::template_application::apply(&f.database, &actor, input.clone(), options).await,
        Err(StoreError::Recovery(_))
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id=$1")
        .bind(&actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    let first =
        forge_store::template_application::apply(&f.database, &actor, input.clone(), options)
            .await
            .unwrap();
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["replayed"], false);
    let retry = forge_store::template_application::apply(&f.database, &actor, input, options)
        .await
        .unwrap();
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["value"], first["value"]);
}
#[tokio::test]
async fn template_deletion_and_default_clearing_require_independent_recovery_preparation() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Template recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Recovery","identifier":"REC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let mut payload = forge_core::templates::empty("issue", Some(&team.id.to_string()));
    payload["name"] = json!("Retained definition");
    let saved = forge_store::templates::save(
        &f.database,
        &actor,
        json!({"slug":team.slug,"payload":payload}),
        false,
    )
    .await
    .unwrap();
    forge_store::templates::set_default(
        &f.database,
        &actor,
        json!({"slug":team.slug,"audience":"members","templateId":saved["id"]}),
    )
    .await
    .unwrap();
    let input = json!({"slug":team.slug,"id":saved["id"]});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(
        forge_store::templates::delete(&f.database, &actor, input.clone(), false)
            .await
            .is_err()
    );
    let loaded =
        forge_store::templates::read(&f.database, &actor, json!({"slug":team.slug}), false)
            .await
            .unwrap();
    assert_eq!(loaded["templates"].as_array().unwrap().len(), 1);
    assert_eq!(loaded["defaults"]["members"], saved["id"]);
    f.backend.mode.store(0, Ordering::SeqCst);
    forge_store::templates::delete(&f.database, &actor, input, false)
        .await
        .unwrap();
    let removed =
        forge_store::templates::read(&f.database, &actor, json!({"slug":team.slug}), false)
            .await
            .unwrap();
    assert_eq!(removed["templates"], json!([]));
    assert!(removed["defaults"]["members"].is_null());
    // The source journal captures the deleted template's identity. Its FK's
    // ON DELETE SET NULL also clears the default when that deletion is replayed;
    // template_id updates are not independently captured by migration 0049.
    let events = f.backend.completed.lock().unwrap();
    assert!(events.iter().any(
        |(_, events)| events.iter().any(|e| e.table == "team_templates"
            && e.action == forge_core::journal::RecoveryAction::Delete
            && e.key.get("id") == Some(&saved["id"]))
    ));
}
