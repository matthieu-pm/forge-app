use super::*;
use chrono::{Datelike, Utc};
use forge_core::billing::calendar::{next_month, stamp};
use serde_json::{Value, json};
#[tokio::test]
async fn renewal_intents_and_refund_confirmations_prepare_before_writes_and_replay_committed_publication_failure()
 {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Billing management recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let svc = forge_store::billing::Service::new(f.database.clone());
    let start = Utc::now()
        .date_naive()
        .with_day(1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let end = next_month(start, 1).unwrap();
    let subscription = Uuid::new_v4();
    svc.apply_subscription_snapshot(json!({"eventId":Uuid::new_v4(),"bodyHash":"a".repeat(64),"snapshot":{"workspaceId":actor.workspace_id,"environment":"sandbox","subscriptionId":subscription,"plan":"starter","status":"active","updatedAt":stamp(start),"currentPeriodStart":stamp(start),"currentPeriodEnd":stamp(end),"pastDueAt":null}})).await.unwrap();
    let input = json!({"requestId":Uuid::new_v4(),"workspaceId":actor.workspace_id,"environment":"sandbox","subscriptionId":subscription,"billingCountry":"FR","fromCurrency":"usd","currentPlan":"starter","renewalPlan":"starter","periodStart":stamp(start),"periodEnd":stamp(end),"providerUpdatedAt":stamp(Utc::now())});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        svc.record_renewal_currency_request(&actor, input.clone())
            .await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_currency_change_requests WHERE workspace_id=$1",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        svc.record_renewal_currency_request(&actor, input.clone())
            .await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        svc.record_renewal_currency_request(&actor, input)
            .await
            .unwrap()["replayed"],
        true
    );
    let order = Uuid::new_v4();
    svc.apply_period_refund(json!({"eventId":Uuid::new_v4(),"bodyHash":"b".repeat(64),"refund":{"scope":"upgrade","workspaceId":actor.workspace_id,"environment":"sandbox","orderId":order,"subscriptionId":subscription,"start":stamp(start),"end":stamp(end),"refundedAt":stamp(Utc::now())}})).await.unwrap();
    let identity = json!({"workspaceId":actor.workspace_id,"environment":"sandbox","subscriptionId":subscription,"orderId":order});
    let context = svc
        .upgrade_refund_renewal_context(identity.clone())
        .await
        .unwrap();
    let proof = json!({"revision":context["revision"],"effectiveAt":context["end"],"providerUpdatedAt":stamp(Utc::now()),"currency":"usd","productId":Uuid::new_v4(),"billedSeats":1,"renewalSeats":1,"status":"scheduled"});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        svc.confirm_upgrade_refund_renewal(identity.clone(), proof.clone())
            .await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.upgrade_refund.renewal_confirmed'").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        svc.confirm_upgrade_refund_renewal(identity.clone(), proof.clone())
            .await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        svc.confirm_upgrade_refund_renewal(identity, proof)
            .await
            .unwrap()["replayed"],
        true
    );
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM workspace_currency_change_requests WHERE workspace_id=$1),(SELECT count(*) FROM billing_event_receipts WHERE workspace_id=$1),(SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.upgrade_refund.renewal_confirmed')").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (1, 4, 1));
    let state: Value = sqlx::query_scalar(
        "SELECT refunded_periods FROM workspace_entitlements WHERE workspace_id=$1",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(state.as_array().unwrap().len(), 1);
}
