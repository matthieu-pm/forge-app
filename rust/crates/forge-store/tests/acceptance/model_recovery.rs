use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
#[path = "../support/model_discovery.rs"]
mod discovery;

#[tokio::test]
async fn model_catalog_replacement_and_credential_deletion_prepare_before_changes() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Model recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let provider = Arc::new(discovery::Provider::default());
    let vault =
        Arc::new(forge_identity::model_vault::Vault::new(&STANDARD.encode([9; 32])).unwrap());
    let mut service = forge_store::agents::model_connections::Service::new(
        f.database.clone(),
        provider.clone(),
        vault,
    );
    let input =
        json!({"provider":"openai","displayName":"Fixture","apiKey":"fixture-private-credential"});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(service.create(&actor, input.clone()).await.is_err());
    assert!(service.list(&actor).await.unwrap().is_empty());
    service
        .managed_environment
        .insert("OPENAI_API_KEY".into(), "fixture-managed".into());
    assert!(service.catalog(&actor, true).await.is_err());
    assert!(service.list(&actor).await.unwrap().is_empty());
    service.managed_environment.clear();
    f.backend.mode.store(0, Ordering::SeqCst);
    let saved = service.create(&actor, input).await.unwrap();
    let id: Uuid = saved["id"].as_str().unwrap().parse().unwrap();
    let thread = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'Selected connection')").bind(thread).bind(&actor.workspace_id).bind(&actor.user_id).execute(&f.pool).await.unwrap();
    forge_store::agents::preferences::upsert(
        &f.database,
        &forge_store::agents::Preference {
            thread_id: thread,
            mode: forge_store::agents::SelectionMode::Manual,
            selected_connection_id: Some(id),
            selected_model_id: Some("gpt-5".into()),
            selected_effort: None,
            updated_at: chrono::Utc::now(),
        },
    )
    .await
    .unwrap();
    *provider.models.lock().unwrap() =
        forge_core::agents::providers::normalize("openai", None, &["gpt-new".into()]);
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(service.refresh(&actor, id).await.is_err());
    assert!(service.delete(&actor, id).await.is_err());
    assert!(
        forge_store::agents::preferences::get(&f.database, thread)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        service.catalog(&actor, true).await.unwrap()[0]["modelId"],
        "gpt-5"
    );
    f.backend.mode.store(0, Ordering::SeqCst);
    service.refresh(&actor, id).await.unwrap();
    assert_eq!(
        service.catalog(&actor, true).await.unwrap()[0]["modelId"],
        "gpt-new"
    );
    service.delete(&actor, id).await.unwrap();
    assert!(
        forge_store::agents::preferences::get(&f.database, thread)
            .await
            .unwrap()
            .is_none()
    );
    let completed = f.backend.completed.lock().unwrap();
    assert!(
        completed
            .iter()
            .flat_map(|(_, events)| events)
            .any(|event| event.table == "model_connections" && event.key["id"] == id.to_string())
    );
    assert!(
        completed
            .iter()
            .flat_map(|(_, events)| events)
            .any(|event| event.table == "model_catalog_entries")
    );
    let json = serde_json::to_string(&*completed).unwrap();
    assert!(
        completed
            .iter()
            .flat_map(|(_, events)| events)
            .any(|event| event.table == "thread_model_preferences"
                && event.key["thread_id"] == thread.to_string())
    );
    assert!(!json.contains("fixture-private-credential"));
    assert!(!json.contains("forge-model-secret"));
}
