use super::*;
use forge_core::invitations::{DeliveryError, Effect};
use forge_store::{
    jobs::invitations::{self, Invitation, Transport},
    jobs::{JobStore, Recovery},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;

#[derive(Default)]
struct Mail {
    calls: Mutex<Vec<String>>,
    receipts: Mutex<HashMap<String, String>>,
    error: Mutex<Option<DeliveryError>>,
    pause: AtomicBool,
    accepted: Notify,
    release: Notify,
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
        invitation: &Invitation,
        effect: Effect,
    ) -> Result<String, DeliveryError> {
        let key = effect.key(&invitation.id);
        self.calls.lock().unwrap().push(key.clone());
        if let Some(error) = *self.error.lock().unwrap() {
            return Err(error);
        }
        let id = self
            .receipts
            .lock()
            .unwrap()
            .entry(key)
            .or_insert_with(|| Uuid::new_v4().to_string())
            .clone();
        self.accepted.notify_one();
        if self.pause.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(id)
    }
}
async fn setup(f: &Fixture) -> (String, Uuid, Uuid, JobStore) {
    let invitation = forge_store::members::invite(
        &f.database,
        &f.actor,
        &forge_store::members::Invite {
            email: format!("{}@example.test", Uuid::new_v4()),
            role: "member".into(),
            resend: false,
        },
    )
    .await
    .unwrap();
    let result = invitations::start(&f.database, &f.actor, &invitation.id)
        .await
        .unwrap();
    let business = Uuid::parse_str(result["businessRunId"].as_str().unwrap()).unwrap();
    let job = sqlx::query_scalar("SELECT id FROM background_jobs WHERE kind=$1 AND identity=$2")
        .bind(invitations::KIND)
        .bind(business.to_string())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    (
        invitation.id,
        business,
        job,
        JobStore::new(f.database.clone()),
    )
}
async fn due(f: &Fixture, job: Uuid) {
    sqlx::query(
        "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(job)
    .execute(&f.pool)
    .await
    .unwrap();
}
async fn age_initial(f: &Fixture, job: Uuid) {
    sqlx::query("UPDATE background_job_steps SET result=jsonb_set(result,'{completedAt}',to_jsonb(clock_timestamp()-interval '25 hours')) WHERE job_id=$1 AND key='initial'")
        .bind(job).execute(&f.pool).await.unwrap();
    due(f, job).await;
}
async fn business_state(f: &Fixture, id: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM business_workflow_runs WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
async fn run(store: &JobStore, mail: &Mail, job: Uuid) -> String {
    invitations::run_next(store, mail, Some(job)).await.unwrap()["state"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn recover(store: &JobStore, job: Uuid, action: &str, outcome: Option<&str>) {
    let generation = store.inspect(Some(job)).await.unwrap()["jobs"][0]["generation"].clone();
    let mut input = json!({"jobId":job,"generation":generation,"requestId":Uuid::new_v4(),"operatorId":Uuid::new_v4(),"reason":if outcome.is_some(){"provider-confirmed"}else{"code-fixed"},"action":action});
    if let Some(outcome) = outcome {
        input["step"] = json!("send:initial");
        input["outcome"] = json!(outcome);
        input["quiesced"] = json!(true);
        input["evidence"] = json!("provider-fixture-receipt");
    }
    store
        .recover(&Recovery::parse(input).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn reservation_is_atomic_idempotent_scoped_and_does_not_steal_sdk_runs() {
    let f = Fixture::new().await;
    let (invitation, business, job, store) = setup(&f).await;
    let results = futures_util::future::join_all(
        (0..8).map(|_| invitations::start(&f.database, &f.actor, &invitation)),
    )
    .await;
    assert!(
        results
            .into_iter()
            .all(|r| r.unwrap()["businessRunId"] == business.to_string())
    );
    let attempts: i32 =
        sqlx::query_scalar("SELECT start_attempts FROM business_workflow_runs WHERE id=$1")
            .bind(business)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(attempts, 1);
    assert_eq!(
        store.inspect(Some(job)).await.unwrap()["jobs"][0]["state"],
        "queued"
    );
    let outsider = Fixture::new().await;
    assert!(matches!(
        invitations::retry(&f.database, &outsider.actor, business).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        invitations::start(&f.database, &outsider.actor, &invitation).await,
        Err(StoreError::NotFound)
    ));
    sqlx::query("UPDATE business_workflow_runs SET sdk_run_id='external-sdk-owner',state='running' WHERE id=$1").bind(business).execute(&f.pool).await.unwrap();
    assert_eq!(
        invitations::retry(&f.database, &f.actor, business)
            .await
            .unwrap()["state"],
        "queued"
    );
    let mail = Mail::default();
    assert_eq!(run(&store, &mail, job).await, "dead");
    assert_eq!(business_state(&f, business).await, "running");
    assert!(mail.calls.lock().unwrap().is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT sdk_run_id FROM business_workflow_runs WHERE id=$1"
        )
        .bind(business)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        "external-sdk-owner"
    );
}

#[tokio::test]
async fn initial_reminder_and_expiry_resume_from_checkpoints_without_duplicate_delivery() {
    let f = Fixture::new().await;
    let (invitation, business, job, store) = setup(&f).await;
    let mail = Mail::default();
    let workers = futures_util::future::join_all((0..4).map(|_| run(&store, &mail, job))).await;
    assert_eq!(workers.iter().filter(|s| *s == "deferred").count(), 1);
    assert_eq!(workers.iter().filter(|s| *s == "idle").count(), 3);
    assert_eq!(run(&store, &mail, job).await, "idle");
    let initial: Value = sqlx::query_scalar(
        "SELECT result FROM background_job_steps WHERE job_id=$1 AND key='initial'",
    )
    .bind(job)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let available: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT available_at FROM background_jobs WHERE id=$1")
            .bind(job)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(
        available,
        initial["completedAt"]
            .as_str()
            .unwrap()
            .parse::<chrono::DateTime<chrono::Utc>>()
            .unwrap()
            + chrono::Duration::hours(24)
    );
    assert_eq!(business_state(&f, business).await, "running");
    age_initial(&f, job).await;
    let restarted = JobStore::new(f.database.clone());
    assert_eq!(run(&restarted, &mail, job).await, "deferred");
    let calls = mail.calls.lock().unwrap().clone();
    assert_eq!(
        calls,
        vec![
            Effect::Initial.key(&invitation),
            Effect::Reminder.key(&invitation)
        ]
    );
    due(&f, job).await;
    assert_eq!(run(&store, &mail, job).await, "deferred");
    assert_eq!(mail.calls.lock().unwrap().len(), 2);
    sqlx::query("UPDATE background_job_steps SET result=jsonb_set(result,'{expiresAt}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE job_id=$1 AND key='initial'").bind(job).execute(&f.pool).await.unwrap();
    sqlx::query(
        "UPDATE invitation SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(&invitation)
    .execute(&f.pool)
    .await
    .unwrap();
    due(&f, job).await;
    assert_eq!(run(&store, &mail, job).await, "completed");
    assert_eq!(business_state(&f, business).await, "completed");
    let status: String = sqlx::query_scalar("SELECT status FROM invitation WHERE id=$1")
        .bind(invitation)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(status, "expired");
    let receipts:i64=sqlx::query_scalar("SELECT count(*) FROM business_workflow_effects WHERE business_run_id=$1 AND state='completed' AND provider_reference IS NOT NULL").bind(business).fetch_one(&f.pool).await.unwrap();
    assert_eq!(receipts, 2);
    let inspect = store.inspect(Some(job)).await.unwrap().to_string();
    assert!(!inspect.contains("@example.test"));
    assert!(!inspect.contains("provider_reference"));
}

#[tokio::test]
async fn live_status_expiry_and_inviter_authority_stop_delivery() {
    for variant in [
        "canceled",
        "accepted",
        "expired",
        "revoked",
        "removed",
        "near-expiry",
    ] {
        let f = Fixture::new().await;
        let (invitation, business, job, store) = setup(&f).await;
        let mail = Mail::default();
        if variant == "near-expiry" {
            assert_eq!(run(&store, &mail, job).await, "deferred");
            age_initial(&f, job).await;
            sqlx::query("UPDATE invitation SET expires_at=clock_timestamp()+interval '14 minutes' WHERE id=$1").bind(&invitation).execute(&f.pool).await.unwrap();
        } else if variant == "expired" {
            sqlx::query("UPDATE invitation SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(&invitation).execute(&f.pool).await.unwrap();
        } else if variant == "revoked" {
            sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
                .bind(&f.actor.workspace_id)
                .bind(&f.actor.user_id)
                .execute(&f.pool)
                .await
                .unwrap();
        } else if variant == "removed" {
            sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
                .bind(&f.actor.workspace_id)
                .bind(&f.actor.user_id)
                .execute(&f.pool)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE invitation SET status=$2 WHERE id=$1")
                .bind(&invitation)
                .bind(variant)
                .execute(&f.pool)
                .await
                .unwrap();
        }
        let denied = matches!(variant, "revoked" | "removed");
        assert_eq!(
            run(&store, &mail, job).await,
            if denied { "dead" } else { "completed" },
            "{variant}"
        );
        assert_eq!(
            business_state(&f, business).await,
            if denied { "failed" } else { "completed" }
        );
        assert_eq!(
            mail.calls.lock().unwrap().len(),
            usize::from(variant == "near-expiry")
        );
    }
}

#[tokio::test]
async fn retryable_mail_failures_keep_the_key_and_follow_source_delays() {
    let f = Fixture::new().await;
    let (_, business, job, store) = setup(&f).await;
    let mail = Mail::default();
    for (status, seconds) in [(429, 60), (503, 5)] {
        *mail.error.lock().unwrap() =
            Some(DeliveryError::provider(Some(status), "validation_error"));
        assert_eq!(run(&store, &mail, job).await, "retry");
        let delay:f64=sqlx::query_scalar("SELECT extract(epoch FROM (available_at-updated_at))::float8 FROM background_jobs WHERE id=$1").bind(job).fetch_one(&f.pool).await.unwrap();
        assert!((delay - f64::from(seconds)).abs() < 0.1);
        let state: (String, String) = sqlx::query_as(
            "SELECT state,failure_code FROM business_workflow_effects WHERE business_run_id=$1",
        )
        .bind(business)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert_eq!(state, ("failed".into(), "email_provider_error".into()));
        due(&f, job).await;
    }
    *mail.error.lock().unwrap() = None;
    assert_eq!(run(&store, &mail, job).await, "deferred");
    assert_eq!(mail.calls.lock().unwrap().len(), 3);
    assert!(
        mail.calls
            .lock()
            .unwrap()
            .windows(2)
            .all(|pair| pair[0] == pair[1])
    );
    assert_eq!(mail.receipts.lock().unwrap().len(), 1);
    let (_, business, job, store) = setup(&f).await;
    *mail.error.lock().unwrap() = Some(DeliveryError::provider(Some(422), "validation_error"));
    assert_eq!(run(&store, &mail, job).await, "dead");
    assert_eq!(business_state(&f, business).await, "failed");
    assert!(
        invitations::retry(&f.database, &f.actor, business)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn interrupted_provider_acceptance_recovers_once_and_expired_or_changed_replays_reconcile() {
    for variant in ["retry", "expired", "changed"] {
        let f = Fixture::new().await;
        let (invitation, business, job, store) = setup(&f).await;
        let mail = Arc::new(Mail::default());
        mail.pause.store(true, Ordering::SeqCst);
        let task = {
            let mail = mail.clone();
            let store = store.clone();
            tokio::spawn(
                async move { invitations::run_next(&store, mail.as_ref(), Some(job)).await },
            )
        };
        mail.accepted.notified().await;
        assert_eq!(mail.receipts.lock().unwrap().len(), 1);
        task.abort();
        let _ = task.await;
        mail.pause.store(false, Ordering::SeqCst);
        // The delivery receipt transaction rolled back, but dispatch was durable.
        let state: String = sqlx::query_scalar(
            "SELECT state FROM background_job_steps WHERE job_id=$1 AND key='send:initial'",
        )
        .bind(job)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert_eq!(state, "started");
        if variant == "expired" {
            sqlx::query("UPDATE background_job_steps SET idempotency_until=clock_timestamp()-interval '1 second' WHERE job_id=$1 AND key='send:initial'").bind(job).execute(&f.pool).await.unwrap();
        } else if variant == "changed" {
            sqlx::query("UPDATE organization SET name='Changed workspace' WHERE id=$1")
                .bind(&f.actor.workspace_id)
                .execute(&f.pool)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1").bind(job).execute(&f.pool).await.unwrap();
        store
            .reap(Some(invitations::KIND), Some(job))
            .await
            .unwrap();
        due(&f, job).await;
        let result = run(&store, mail.as_ref(), job).await;
        assert_eq!(
            result,
            if variant == "retry" {
                "deferred"
            } else if variant == "expired" {
                "idle"
            } else {
                "reconcile"
            },
            "{variant}"
        );
        assert_eq!(
            mail.calls.lock().unwrap().len(),
            if variant == "retry" { 2 } else { 1 }
        );
        assert_eq!(mail.receipts.lock().unwrap().len(), 1);
        if variant != "retry" {
            assert_eq!(
                store.inspect(Some(job)).await.unwrap()["jobs"][0]["state"],
                "reconcile"
            );
            assert_eq!(business_state(&f, business).await, "failed");
            recover(&store, job, "resolve", Some("completed")).await;
            recover(&store, job, "replay", None).await;
            assert_eq!(run(&store, mail.as_ref(), job).await, "deferred");
            assert_eq!(mail.calls.lock().unwrap().len(), 1);
        }
        assert_eq!(
            mail.calls.lock().unwrap()[0],
            Effect::Initial.key(&invitation)
        );
    }
}

#[tokio::test]
async fn current_inviter_and_invitation_locks_cover_the_provider_call() {
    let f = Fixture::new().await;
    let (_, _, job, store) = setup(&f).await;
    let mail = Arc::new(Mail::default());
    mail.pause.store(true, Ordering::SeqCst);
    let task = {
        let mail = mail.clone();
        let store = store.clone();
        tokio::spawn(async move { invitations::run_next(&store, mail.as_ref(), Some(job)).await })
    };
    mail.accepted.notified().await;
    let revoke = {
        let pool = f.pool.clone();
        let workspace = f.actor.workspace_id.clone();
        let user = f.actor.user_id.clone();
        tokio::spawn(async move {
            sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
                .bind(workspace)
                .bind(user)
                .execute(&pool)
                .await
                .unwrap();
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!revoke.is_finished());
    mail.pause.store(false, Ordering::SeqCst);
    mail.release.notify_one();
    assert_eq!(task.await.unwrap().unwrap()["state"], "deferred");
    revoke.await.unwrap();
    age_initial(&f, job).await;
    assert_eq!(run(&store, mail.as_ref(), job).await, "dead");
    assert_eq!(mail.calls.lock().unwrap().len(), 1);
}
