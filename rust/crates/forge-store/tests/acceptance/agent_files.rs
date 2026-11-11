use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use blobs::Memory;
use forge_core::agents::files::Code;
use forge_store::agents::files::Service;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
fn service(f: &Fixture) -> (Service, Arc<Memory>, Arc<AtomicI64>) {
    let blobs = Arc::new(Memory::default());
    let clock = Arc::new(AtomicI64::new(at().timestamp_millis()));
    let read = clock.clone();
    let mut service = Service::new(f.database.clone(), blobs.clone());
    service.now =
        Arc::new(move || DateTime::from_timestamp_millis(read.load(Ordering::SeqCst)).unwrap());
    (service, blobs, clock)
}
fn attachment(name: &str, bytes: &[u8]) -> Value {
    json!({"name":name,"contentType":"text/plain","contentBase64":STANDARD.encode(bytes)})
}
fn artifact(name: &str, content: &str) -> Value {
    json!({"name":name,"contentType":"text/plain","content":content})
}
fn id(value: &Value) -> Uuid {
    value["id"].as_str().unwrap().parse().unwrap()
}
fn code<T: std::fmt::Debug>(result: Result<T, StoreError>, code: Code) {
    match result.unwrap_err() {
        StoreError::AgentFile(error) => assert_eq!(error.code, code),
        other => panic!("Unexpected {other:?}"),
    }
}

#[tokio::test]
async fn attachments_preserve_private_ordered_bytes_limits_integrity_and_expiry() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let (mut service, blobs, clock) = service(&f);
    let first = service
        .upload_attachment(&f.actor, attachment("first.txt", b"hello"))
        .await
        .unwrap();
    let second = service
        .upload_attachment(&f.actor, attachment("second.txt", b"second"))
        .await
        .unwrap();
    assert_eq!(first["expiresAt"], "2026-11-02T12:00:00.000Z");
    for key in ["workspaceId", "userId", "storageReference", "deletedAt"] {
        assert!(first.get(key).is_none());
    }
    let resolved = service
        .resolve_attachments(&f.actor, &[id(&second), id(&first)])
        .await
        .unwrap();
    assert_eq!(resolved[0]["id"], second["id"]);
    assert_eq!(resolved[1]["contentBase64"], STANDARD.encode(b"hello"));
    code(
        service.resolve_attachments(&member, &[id(&first)]).await,
        Code::AttachmentNotFound,
    );
    code(
        service
            .resolve_attachments(&f.actor, &[id(&first), id(&first)])
            .await,
        Code::InvalidAttachment,
    );
    code(
        service
            .resolve_attachments(
                &f.actor,
                &(0..21).map(|_| Uuid::new_v4()).collect::<Vec<_>>(),
            )
            .await,
        Code::InvalidAttachment,
    );
    assert!(
        service
            .resolve_attachments(&f.actor, &[])
            .await
            .unwrap()
            .is_empty()
    );
    service.settings.max_turn_bytes = 10;
    code(
        service
            .resolve_attachments(&f.actor, &[id(&first), id(&second)])
            .await,
        Code::AttachmentTooLarge,
    );
    service.settings.max_turn_bytes = 11;
    assert_eq!(
        service
            .resolve_attachments(&f.actor, &[id(&first), id(&second)])
            .await
            .unwrap()
            .len(),
        2
    );
    service.settings.max_attachment_bytes = 4;
    code(
        service
            .upload_attachment(&f.actor, attachment("large.txt", b"hello"))
            .await,
        Code::AttachmentTooLarge,
    );
    code(
        service
            .upload_attachment(
                &f.actor,
                json!({"name":"bad.txt","contentType":"text/plain","contentBase64":"AB=="}),
            )
            .await,
        Code::InvalidAttachment,
    );
    let reference = format!("attachments/{}", id(&first));
    blobs
        .values
        .lock()
        .unwrap()
        .insert(reference.clone(), b"HELLO".to_vec());
    code(
        service.resolve_attachments(&f.actor, &[id(&first)]).await,
        Code::InvalidAttachment,
    );
    blobs.values.lock().unwrap().remove(&reference);
    code(
        service.resolve_attachments(&f.actor, &[id(&first)]).await,
        Code::AttachmentNotFound,
    );
    clock.store(
        (at() + Duration::days(1)).timestamp_millis(),
        Ordering::SeqCst,
    );
    code(
        service.resolve_attachments(&f.actor, &[id(&second)]).await,
        Code::AttachmentNotFound,
    );
}

#[tokio::test]
async fn attachment_upload_policy_and_revocation_during_io_prevent_publication_and_delivery() {
    let f = Fixture::new().await;
    let (service, blobs, _) = service(&f);
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,restrict_file_uploads) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET restrict_file_uploads=true").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        service
            .upload_attachment(&f.actor, attachment("blocked.txt", b"hello"))
            .await,
        Err(StoreError::Forbidden)
    ));
    assert!(blobs.values.lock().unwrap().is_empty());
    sqlx::query("UPDATE workspace_security_settings SET allowed_upload_types='[\"text/plain\"]' WHERE workspace_id=$1").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let saved = service
        .upload_attachment(&f.actor, attachment("allowed.txt", b"hello"))
        .await
        .unwrap();
    blobs.pause_get.store(true, Ordering::SeqCst);
    let saved_ids = [id(&saved)];
    let (read, ()) = tokio::join!(service.resolve_attachments(&f.actor, &saved_ids), async {
        blobs.entered.notified().await;
        sqlx::query("UPDATE agent_attachments SET deleted_at=clock_timestamp() WHERE id=$1")
            .bind(id(&saved))
            .execute(&f.pool)
            .await
            .unwrap();
        blobs.resume.notify_one();
    });
    code(read, Code::AttachmentNotFound);
    blobs.pause_put.store(true, Ordering::SeqCst);
    let (upload, ()) = tokio::join!(
        service.upload_attachment(&f.actor, attachment("revoked.txt", b"private")),
        async {
            blobs.entered.notified().await;
            sqlx::query("DELETE FROM session WHERE token=$1")
                .bind(&f.token)
                .execute(&f.pool)
                .await
                .unwrap();
            blobs.resume.notify_one();
        }
    );
    assert!(matches!(upload, Err(StoreError::Forbidden)));
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_attachments WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn artifacts_are_deduplicated_private_and_bound_to_live_actor_run_and_download() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let (mut service, blobs, clock) = service(&f);
    let input = artifact("report.txt", "hello");
    let first = service
        .create_artifact(&f.actor, run.id, input.clone())
        .await
        .unwrap();
    assert_eq!(
        service
            .create_artifact(&f.actor, run.id, input)
            .await
            .unwrap(),
        first
    );
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
    assert_eq!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(first.get("storageReference").is_none());
    assert_eq!(first["retentionExpiresAt"], "2026-12-01T12:00:00.000Z");
    code(
        service
            .create_artifact(&member, run.id, artifact("other.txt", "hello"))
            .await,
        Code::ArtifactNotFound,
    );
    code(
        service.artifact_metadata(&member, id(&first)).await,
        Code::ArtifactNotFound,
    );
    let (metadata, bytes) = service.read_artifact(&f.actor, id(&first)).await.unwrap();
    assert_eq!(metadata, first);
    assert_eq!(bytes, b"hello");
    let secret = "public-artifact-fixture-secret-at-least-32";
    let download = service
        .artifact_download(&f.actor, id(&first), secret)
        .await
        .unwrap();
    let token = download["downloadUrl"]
        .as_str()
        .unwrap()
        .split("?token=")
        .nth(1)
        .unwrap();
    forge_core::agents::tokens::verify_artifact(
        secret,
        token,
        &f.actor,
        &id(&first).to_string(),
        at().timestamp(),
    )
    .unwrap();
    assert_eq!(download["expiresInSeconds"], 300);
    assert!(
        forge_core::agents::tokens::verify_artifact(
            secret,
            token,
            &member,
            &id(&first).to_string(),
            at().timestamp()
        )
        .is_err()
    );
    let empty = service
        .create_artifact(&f.actor, run.id, artifact("empty.txt", ""))
        .await
        .unwrap();
    assert_eq!(empty["sizeBytes"], 0);
    assert!(
        service
            .read_artifact(&f.actor, id(&empty))
            .await
            .unwrap()
            .1
            .is_empty()
    );
    let permissive=service.create_artifact(&f.actor,run.id,json!({"name":"base64.txt","contentType":"text/plain","encoding":"base64","content":"a?GVsbG8="})).await.unwrap();
    assert_eq!(
        service
            .read_artifact(&f.actor, id(&permissive))
            .await
            .unwrap()
            .1,
        b"hello"
    );
    let reference = format!("{}/{}", run.id, id(&first));
    blobs
        .values
        .lock()
        .unwrap()
        .insert(reference, b"HELLO".to_vec());
    code(
        service.read_artifact(&f.actor, id(&first)).await,
        Code::InvalidArtifactContent,
    );
    service.settings.max_artifact_bytes = 4;
    code(
        service
            .create_artifact(&f.actor, run.id, artifact("big.txt", "hello"))
            .await,
        Code::ArtifactTooLarge,
    );
    clock.store(
        (at() + Duration::days(30)).timestamp_millis(),
        Ordering::SeqCst,
    );
    code(
        service.artifact_metadata(&f.actor, id(&empty)).await,
        Code::ArtifactNotFound,
    );
}

#[tokio::test]
async fn artifact_publication_rolls_back_unsafe_events_and_rechecks_access_after_storage() {
    let f = Fixture::new().await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let (service, blobs, _) = service(&f);
    assert!(
        service
            .create_artifact(
                &f.actor,
                run.id,
                artifact("Bearer abcdefghijklmnop", "private")
            )
            .await
            .is_err()
    );
    assert!(blobs.values.lock().unwrap().is_empty());
    assert!(
        events::list_run(&f.database, run.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_artifacts WHERE run_id=$1")
        .bind(run.id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let saved = service
        .create_artifact(&f.actor, run.id, artifact("saved.txt", "hello"))
        .await
        .unwrap();
    blobs.pause_get.store(true, Ordering::SeqCst);
    let (read, ()) = tokio::join!(service.read_artifact(&f.actor, id(&saved)), async {
        blobs.entered.notified().await;
        sqlx::query("UPDATE agent_artifacts SET deleted_at=clock_timestamp() WHERE id=$1")
            .bind(id(&saved))
            .execute(&f.pool)
            .await
            .unwrap();
        blobs.resume.notify_one();
    });
    code(read, Code::ArtifactNotFound);
    // The existing unique identity includes deleted artifacts. A failed new
    // publication must clean only its own new bytes, retaining the earlier key.
    assert!(
        service
            .create_artifact(&f.actor, run.id, artifact("saved.txt", "hello"))
            .await
            .is_err()
    );
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
    blobs.pause_put.store(true, Ordering::SeqCst);
    let (create, ()) = tokio::join!(
        service.create_artifact(&f.actor, run.id, artifact("revoked.txt", "private")),
        async {
            blobs.entered.notified().await;
            sqlx::query("DELETE FROM session WHERE token=$1")
                .bind(&f.token)
                .execute(&f.pool)
                .await
                .unwrap();
            blobs.resume.notify_one();
        }
    );
    assert!(matches!(create, Err(StoreError::Forbidden)));
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn artifact_creation_is_connected_to_the_capability_gateway() {
    let f = Fixture::new().await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let (service, blobs, _) = service(&f);
    let gateway = forge_store::agents::capabilities::Gateway::new(f.database.clone())
        .with_artifacts(Arc::new(service));
    let result=gateway.invoke(&f.actor,json!({"capabilityId":"artifacts.create","capabilityVersion":"1","input":artifact("gateway.txt","Generated")}),run.id).await;
    assert_eq!(result["ok"], true);
    assert_eq!(result["value"]["sizeBytes"], 9);
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
    assert_eq!(
        events::list_run(&f.database, run.id, 0).await.unwrap()[0].kind,
        "artifact.created"
    );
}

#[tokio::test]
async fn retention_retries_failed_bytes_and_competing_workers_delete_each_object_once() {
    let _guard = crate::issue_purge_acceptance::SERIAL.lock().await;
    let f = Fixture::using("FORGE_RUST_RETENTION_TEST_DATABASE_URL").await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let (service, blobs, clock) = service(&f);
    let start: DateTime<Utc> = "2000-01-01T00:00:00Z".parse().unwrap();
    clock.store(start.timestamp_millis(), Ordering::SeqCst);
    let attachment = service
        .upload_attachment(&f.actor, attachment("expires.txt", b"private"))
        .await
        .unwrap();
    let artifact = service
        .create_artifact(&f.actor, run.id, artifact("expires.txt", "private"))
        .await
        .unwrap();
    assert_eq!(
        service.sweep_attachments(start, 100).await.unwrap().deleted,
        0
    );
    assert_eq!(
        service.sweep_artifacts(start, 100).await.unwrap().deleted,
        0
    );
    let before = start + Duration::days(31);
    blobs.fail_delete.store(true, Ordering::SeqCst);
    let report = service.sweep_attachments(before, 100).await.unwrap();
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.deleted, 0);
    let report = service.sweep_artifacts(before, 100).await.unwrap();
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.deleted, 0);
    assert_eq!(blobs.values.lock().unwrap().len(), 2);
    blobs.fail_delete.store(false, Ordering::SeqCst);
    let (a, b) = tokio::join!(
        service.sweep_attachments(before, 100),
        service.sweep_attachments(before, 100)
    );
    assert_eq!(a.unwrap().deleted + b.unwrap().deleted, 1);
    let (a, b) = tokio::join!(
        service.sweep_artifacts(before, 100),
        service.sweep_artifacts(before, 100)
    );
    assert_eq!(a.unwrap().deleted + b.unwrap().deleted, 1);
    assert_eq!(blobs.deleted.load(Ordering::SeqCst), 2);
    assert!(blobs.values.lock().unwrap().is_empty());
    for (table, id) in [
        ("agent_attachments", id(&attachment)),
        ("agent_artifacts", id(&artifact)),
    ] {
        let deleted: DateTime<Utc> =
            sqlx::query_scalar(&format!("SELECT deleted_at FROM {table} WHERE id=$1"))
                .bind(id)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(deleted, before);
    }
}

#[tokio::test]
async fn expired_loop_reservations_keep_published_bytes_and_retry_unpublished_cleanup() {
    let _guard = crate::issue_purge_acceptance::SERIAL.lock().await;
    let f = Fixture::using("FORGE_RUST_RETENTION_TEST_DATABASE_URL").await;
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let (service, blobs, clock) = service(&f);
    let now: DateTime<Utc> = "2000-02-01T00:00:00Z".parse().unwrap();
    clock.store(now.timestamp_millis(), Ordering::SeqCst);
    let published = service
        .create_artifact(&f.actor, run.id, artifact("published.txt", "private"))
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&f.actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Retention team","identifier":"RET","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap().id;
    let loop_id = Uuid::new_v4();
    let loop_run = Uuid::new_v4();
    sqlx::query("INSERT INTO team_loops(id,workspace_id,team_id,fields,enabled,enabled_by_id,enabled_at) VALUES($1,$2,$3,'{}',true,$4,$5)").bind(loop_id).bind(&f.actor.workspace_id).bind(team).bind(&f.actor.user_id).bind(now).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,thread_id,agent_run_id) VALUES($1,$2,$3,1,'retention',$4,'{}','{}',$5,'running',$6,$7)").bind(loop_run).bind(&f.actor.workspace_id).bind(loop_id).bind("a".repeat(64)).bind(&f.actor.user_id).bind(thread.id).bind(run.id).execute(&f.pool).await.unwrap();
    let orphan = Uuid::new_v4();
    let live = Uuid::new_v4();
    for (id, created) in [
        (id(&published), now - Duration::minutes(20)),
        (orphan, now - Duration::minutes(20)),
        (live, now),
    ] {
        let reference = format!("{}/{id}", run.id);
        blobs
            .values
            .lock()
            .unwrap()
            .entry(reference.clone())
            .or_insert(b"private".to_vec());
        sqlx::query("INSERT INTO loop_artifact_intents(id,workspace_id,loop_run_id,agent_run_id,storage_reference,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(&f.actor.workspace_id).bind(loop_run).bind(run.id).bind(reference).bind(created).execute(&f.pool).await.unwrap();
    }
    blobs.fail_delete.store(true, Ordering::SeqCst);
    let report = service.sweep_artifacts(now, 100).await.unwrap();
    assert_eq!(report.examined, 2);
    assert_eq!(report.deleted, 0);
    assert_eq!(report.failures.len(), 1);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM loop_artifact_intents WHERE agent_run_id=$1")
            .bind(run.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
    blobs.fail_delete.store(false, Ordering::SeqCst);
    let report = service.sweep_artifacts(now, 100).await.unwrap();
    assert_eq!(report.deleted, 1);
    assert!(report.failures.is_empty());
    {
        let values = blobs.values.lock().unwrap();
        assert!(values.contains_key(&format!("{}/{}", run.id, id(&published))));
        assert!(values.contains_key(&format!("{}/{live}", run.id)));
        assert!(!values.contains_key(&format!("{}/{orphan}", run.id)));
    }
    // Retire this test's live reservation before another global retention pass.
    sqlx::query("DELETE FROM loop_artifact_intents WHERE agent_run_id=$1")
        .bind(run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_artifacts SET deleted_at=$2 WHERE run_id=$1")
        .bind(run.id)
        .bind(now)
        .execute(&f.pool)
        .await
        .unwrap();
}
