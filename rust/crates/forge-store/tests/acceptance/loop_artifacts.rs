use super::agent_blobs as blobs;
use super::loop_authority_acceptance::{callback, claimed, occurrence};
use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_store::agents::files::Service;
use std::sync::{Arc, atomic::Ordering};

fn files(f: &Fixture) -> (Service, Arc<blobs::Memory>) {
    let blobs = Arc::new(blobs::Memory::default());
    (Service::new(f.database.clone(), blobs.clone()), blobs)
}
fn artifact(name: &str) -> Value {
    json!({"name":name,"contentType":"text/plain","content":"Private loop result"})
}
async fn counts(f: &Fixture, run: Uuid) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM loop_artifact_intents WHERE agent_run_id=$1),(SELECT count(*) FROM agent_artifacts WHERE run_id=$1),(SELECT count(*) FROM agent_events WHERE run_id=$1 AND type='artifact.created')").bind(run).fetch_one(&f.pool).await.unwrap()
}

#[tokio::test]
async fn loop_upload_reserves_before_io_then_publishes_one_artifact_and_event_with_exact_run_binding()
 {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 116).await;
    let c = claimed(&f, team, json!({"kind":"manual"}), false).await;
    let other = occurrence(&f, c.definition, json!({"kind":"manual"})).await;
    let (service, blobs) = files(&f);
    assert!(
        service
            .create_artifact(&c.actor, other.agent_run, artifact("cross-run.txt"))
            .await
            .is_err()
    );
    assert!(blobs.values.lock().unwrap().is_empty());
    let agent = callback(&c);
    blobs.pause_put.store(true, Ordering::SeqCst);
    let upload = service.create_artifact(&agent, c.agent_run, artifact("result.txt"));
    let observe = async {
        blobs.entered.notified().await;
        assert_eq!(counts(&f, c.agent_run).await, (1, 0, 0));
        assert_eq!(blobs.values.lock().unwrap().len(), 1);
        blobs.resume.notify_one();
    };
    let (saved, ()) = tokio::join!(upload, observe);
    let saved = saved.unwrap();
    assert_eq!(counts(&f, c.agent_run).await, (0, 1, 1));
    assert_eq!(
        service
            .create_artifact(&agent, c.agent_run, artifact("result.txt"))
            .await
            .unwrap(),
        saved
    );
    assert_eq!(counts(&f, c.agent_run).await, (0, 1, 1));
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
    let id = saved["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        service.read_artifact(&agent, id).await.unwrap().1,
        b"Private loop result"
    );
    assert!(
        service
            .artifact_metadata(&callback(&other), id)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn source_revocation_during_upload_prevents_metadata_and_compensates_unpublished_bytes() {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 117).await;
    let issue = issue_acceptance::create(&f, team, "Upload source").await;
    let c = claimed(
        &f,
        team,
        json!({"kind":"event","entity":"issue","entityId":issue["id"],"event":"created"}),
        false,
    )
    .await;
    let (service, blobs) = files(&f);
    blobs.pause_put.store(true, Ordering::SeqCst);
    let upload = service.create_artifact(&c.actor, c.agent_run, artifact("revoked.txt"));
    let revoke = async {
        blobs.entered.notified().await;
        assert_eq!(counts(&f, c.agent_run).await, (1, 0, 0));
        sqlx::query("UPDATE issues SET deleted_at=clock_timestamp() WHERE id::text=$1")
            .bind(issue["id"].as_str().unwrap())
            .execute(&f.pool)
            .await
            .unwrap();
        blobs.resume.notify_one();
    };
    let (result, ()) = tokio::join!(upload, revoke);
    assert!(matches!(result, Err(StoreError::Forbidden)));
    assert_eq!(counts(&f, c.agent_run).await, (0, 0, 0));
    assert!(blobs.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn interrupted_uploads_and_failed_cleanup_keep_durable_intents_until_bounded_sweep() {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 118).await;
    let c = claimed(&f, team, json!({"kind":"manual"}), false).await;
    let (service, blobs) = files(&f);
    let old: DateTime<Utc> = "1880-01-01T00:00:00Z".parse().unwrap();
    for interrupted in [true, false] {
        blobs.pause_put.store(true, Ordering::SeqCst);
        if interrupted {
            // Dropping the future models process interruption after the provider
            // has accepted bytes but before publication can begin.
            let mut upload = Box::pin(service.create_artifact(
                &c.actor,
                c.agent_run,
                artifact("interrupted.txt"),
            ));
            tokio::select! {
                result=&mut upload=>panic!("Upload unexpectedly finished: {result:?}"),
                ()=blobs.entered.notified()=>{}
            }
            drop(upload);
        } else {
            // Expire only this reservation while the upload is in flight. Its
            // exact lease must be checked again before publication.
            blobs.fail_delete.store(true, Ordering::SeqCst);
            let upload = service.create_artifact(&c.actor, c.agent_run, artifact("expired.txt"));
            let expire = async {
                blobs.entered.notified().await;
                sqlx::query("UPDATE loop_artifact_intents SET created_at=$2 WHERE agent_run_id=$1")
                    .bind(c.agent_run)
                    .bind(old)
                    .execute(&f.pool)
                    .await
                    .unwrap();
                blobs.resume.notify_one();
            };
            let (result, ()) = tokio::join!(upload, expire);
            assert!(matches!(result, Err(StoreError::Forbidden)));
        }
        assert_eq!(counts(&f, c.agent_run).await, (1, 0, 0));
        assert_eq!(blobs.values.lock().unwrap().len(), 1);
        sqlx::query("UPDATE loop_artifact_intents SET created_at=$2 WHERE agent_run_id=$1")
            .bind(c.agent_run)
            .bind(old)
            .execute(&f.pool)
            .await
            .unwrap();
        blobs.fail_delete.store(true, Ordering::SeqCst);
        let failed = service
            .sweep_artifacts(old + Duration::minutes(21), 10)
            .await
            .unwrap();
        assert_eq!(failed.failures.len(), 1);
        assert_eq!(counts(&f, c.agent_run).await, (1, 0, 0));
        blobs.fail_delete.store(false, Ordering::SeqCst);
        let swept = service
            .sweep_artifacts(old + Duration::minutes(21), 10)
            .await
            .unwrap();
        assert_eq!(swept.deleted, 1);
        assert_eq!(counts(&f, c.agent_run).await, (0, 0, 0));
        assert!(blobs.values.lock().unwrap().is_empty());
    }
}
