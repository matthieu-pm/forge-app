use super::agent_blobs as blobs;
use super::*;
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

#[tokio::test]
async fn agent_byte_publication_and_retention_respect_journal_failures() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Agent bytes",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let thread = Uuid::new_v4();
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'Recovery bytes')").bind(thread).bind(&actor.workspace_id).bind(&actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'created','forge-native','{}')").bind(run).bind(thread).bind(&actor.user_id).execute(&f.pool).await.unwrap();
    let blobs = Arc::new(blobs::Memory::default());
    let mut service = forge_store::agents::files::Service::new(f.database.clone(), blobs.clone());
    let now: DateTime<Utc> = "1990-01-01T00:00:00Z".parse().unwrap();
    service.now = Arc::new(move || now);
    let attachment =
        json!({"name":"private.txt","contentType":"text/plain","contentBase64":"cHJpdmF0ZQ=="});
    let artifact = json!({"name":"private.txt","contentType":"text/plain","content":"private content excluded from journal"});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(
        service
            .upload_attachment(&actor, attachment.clone())
            .await
            .is_err()
    );
    assert!(
        service
            .create_artifact(&actor, run, artifact.clone())
            .await
            .is_err()
    );
    assert!(blobs.values.lock().unwrap().is_empty());
    // SQL commits while archive publication fails. Metadata owns both objects,
    // so the compensation probe must preserve them despite the returned error.
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(service.upload_attachment(&actor, attachment).await.is_err());
    assert!(
        service
            .create_artifact(&actor, run, artifact.clone())
            .await
            .is_err()
    );
    assert_eq!(blobs.values.lock().unwrap().len(), 2);
    let aid: Uuid = sqlx::query_scalar("SELECT id FROM agent_attachments WHERE workspace_id=$1")
        .bind(&actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    f.backend.mode.store(0, Ordering::SeqCst);
    let saved = service
        .create_artifact(&actor, run, artifact)
        .await
        .unwrap();
    let rid: Uuid = saved["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        forge_store::agents::events::list_run(&f.database, run, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        service.resolve_attachments(&actor, &[aid]).await.unwrap()[0]["contentBase64"],
        "cHJpdmF0ZQ=="
    );
    assert_eq!(
        service.read_artifact(&actor, rid).await.unwrap().1,
        b"private content excluded from journal"
    );
    let before = now + Duration::days(31);
    let deletions = blobs.deleted.load(Ordering::SeqCst);
    f.backend.mode.store(1, Ordering::SeqCst);
    assert_eq!(
        service
            .sweep_attachments(before, 100)
            .await
            .unwrap()
            .failures
            .len(),
        1
    );
    assert_eq!(
        service
            .sweep_artifacts(before, 100)
            .await
            .unwrap()
            .failures
            .len(),
        1
    );
    assert_eq!(blobs.deleted.load(Ordering::SeqCst), deletions);
    assert_eq!(blobs.values.lock().unwrap().len(), 2);
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        service
            .sweep_attachments(before, 100)
            .await
            .unwrap()
            .deleted,
        1
    );
    assert_eq!(
        service.sweep_artifacts(before, 100).await.unwrap().deleted,
        1
    );
    let archived = f.backend.completed.lock().unwrap();
    for (table, id) in [("agent_attachments", aid), ("agent_artifacts", rid)] {
        assert!(archived.iter().flat_map(|(_, events)| events).any(|event| {
            event.table == table
                && event.key["id"] == id.to_string()
                && event
                    .patch
                    .as_ref()
                    .and_then(|p| p.get("deleted_at"))
                    .is_some_and(|v| *v != Value::Null)
                && event.storage_reference.is_some()
        }));
    }
    assert!(
        !serde_json::to_string(&*archived)
            .unwrap()
            .contains("private content excluded from journal")
    );
}
