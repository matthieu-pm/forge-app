use super::*;
use forge_core::invitations::{DeliveryError, Effect};
use forge_store::jobs::{
    JobStore,
    invitations::{self, Invitation, Transport},
};
use serde_json::json;

struct Mail {
    backend: Arc<CaptureJournal>,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl Transport for Mail {
    fn fingerprint(
        &self,
        invitation: &Invitation,
        effect: Effect,
    ) -> Result<String, DeliveryError> {
        Ok(forge_core::canonical::command_input_hash(
            &json!({"invitation":invitation,"effect":effect}),
        ))
    }
    async fn deliver(
        &self,
        _invitation: &Invitation,
        _effect: Effect,
    ) -> Result<String, DeliveryError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.backend.mode.store(2, Ordering::SeqCst);
        Ok("fixture-provider-receipt".into())
    }
}
#[tokio::test]
async fn invitation_queue_and_delivery_prepare_before_effects_and_preserve_unknown_publication_receipts()
 {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Invitation recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let invitation = forge_store::members::invite(
        &f.database,
        &actor,
        &forge_store::members::Invite {
            email: format!("{}@example.test", Uuid::new_v4()),
            role: "member".into(),
            resend: false,
        },
    )
    .await
    .unwrap();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(
        invitations::start(&f.database, &actor, &invitation.id)
            .await
            .is_err()
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM business_workflow_runs WHERE subject_id=$1")
            .bind(&invitation.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    let run = invitations::start(&f.database, &actor, &invitation.id)
        .await
        .unwrap();
    let business = Uuid::parse_str(run["businessRunId"].as_str().unwrap()).unwrap();
    let job: Uuid =
        sqlx::query_scalar("SELECT id FROM background_jobs WHERE identity=$1 AND kind=$2")
            .bind(business.to_string())
            .bind(invitations::KIND)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let store = JobStore::new(f.database.clone());
    let mail = Mail {
        backend: f.backend.clone(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(
        invitations::run_next(&store, &mail, Some(job))
            .await
            .is_err()
    );
    assert_eq!(mail.calls.load(Ordering::SeqCst), 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    // Delivery succeeds; independent receipt publication fails after SQL commit.
    assert!(
        invitations::run_next(&store, &mail, Some(job))
            .await
            .is_err()
    );
    assert_eq!(mail.calls.load(Ordering::SeqCst), 1);
    let receipt: (String, String) = sqlx::query_as(
        "SELECT state,provider_reference FROM business_workflow_effects WHERE business_run_id=$1",
    )
    .bind(business)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        receipt,
        ("completed".into(), "fixture-provider-receipt".into())
    );
    let checkpoint: String = sqlx::query_scalar(
        "SELECT state FROM background_job_steps WHERE job_id=$1 AND key='initial'",
    )
    .bind(job)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(checkpoint, "completed");
    f.backend.mode.store(0, Ordering::SeqCst);
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query(
        "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(job)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        invitations::run_next(&store, &mail, Some(job))
            .await
            .unwrap()["state"],
        "deferred"
    );
    assert_eq!(mail.calls.load(Ordering::SeqCst), 1);
}
