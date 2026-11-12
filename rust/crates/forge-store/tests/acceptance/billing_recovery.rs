use super::*;
use serde_json::{Value, json};

#[tokio::test]
async fn trial_and_usage_require_recovery_preparation_and_preserve_committed_receipts_after_publication_failure()
 {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Billing recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let service = forge_store::billing::Service::new(f.database.clone());
    let trial = json!({"requestId":Uuid::new_v4(),"plan":"plus"});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.start_trial(&actor, trial.clone()).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_trial_redemptions WHERE workspace_id=$1",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        service.start_trial(&actor, trial.clone()).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        service.start_trial(&actor, trial).await.unwrap()["replayed"],
        true
    );
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM workspace_trial_redemptions WHERE workspace_id=$1),(SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.trial.started')").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (1, 1));
    let thread = Uuid::new_v4();
    let connection = Uuid::new_v4();
    let run = Uuid::new_v4();
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,runtime_kind) VALUES($1,$2,$3,'eve')").bind(thread).bind(&actor.workspace_id).bind(&actor.user_id).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,created_by_user_id) VALUES($1,$2,'workspace','fixture-provider','managed','forge-native','server-capable','forge-managed','forge-server-vault','Usage fixture','ready',$3)").bind(connection).bind(&actor.workspace_id).bind(&actor.user_id).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO model_catalog_entries(connection_id,selection_id,provider_model_id,display_name,provider_label,source_label,execution_kind) VALUES($1,$2,'fixture-model','Fixture model','Fixture provider','Fixture','forge-native')").bind(connection).bind(format!("{connection}:fixture-model")).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let command = json!({"requestId":Uuid::new_v4(),"runId":run,"threadId":thread,"connectionId":connection,"modelId":"fixture-model","maximumCostUsdMicros":3_000_000,"pricingFingerprint":"a".repeat(64)});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.admit_agent_usage(&actor, command.clone()).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        service.admit_agent_usage(&actor, command.clone()).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        service.admit_agent_usage(&actor, command).await.unwrap()["replayed"],
        true
    );
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM agent_runs WHERE id=$1),(SELECT count(*) FROM workspace_usage_reservations WHERE id=$1),(SELECT count(*) FROM agent_events WHERE run_id=$1)").bind(run).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    let settle = json!({"workspaceId":actor.workspace_id,"reservationId":run,"eventId":Uuid::new_v4(),"outcome":"settled","providerCostUsdMicros":2_000_000});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.settle_agent_usage(settle.clone()).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let state:(String,i64,i64)=sqlx::query_as("SELECT state,settled_usd_micros,reserved_usd_micros FROM workspace_usage_reservations WHERE id=$1").bind(run).fetch_one(&f.pool).await.unwrap();
    assert_eq!(state, ("held".into(), 0, 3_000_000));
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        service.settle_agent_usage(settle.clone()).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    let replay = service.settle_agent_usage(settle).await.unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["settledUsdMicros"], 2_000_000);
    let receipts: Vec<Value> =
        sqlx::query_scalar("SELECT result FROM workspace_usage_receipts WHERE reservation_id=$1")
            .bind(run)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        service.inspect_usage(&actor.workspace_id).await.unwrap()["reservedUsdMicros"],
        0
    );
}

#[tokio::test]
async fn verified_subscription_and_refund_writes_require_preparation_and_survive_publication_failure()
 {
    use chrono::{Duration, Utc};
    use forge_core::billing::calendar::stamp;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Subscription recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let svc = forge_store::billing::Service::new(f.database.clone());
    let now = Utc::now();
    let input = json!({"eventId":Uuid::new_v4(),"bodyHash":"a".repeat(64),"snapshot":{"workspaceId":actor.workspace_id,"environment":"sandbox","subscriptionId":Uuid::new_v4(),"plan":"starter","status":"active","updatedAt":stamp(now-Duration::days(1)),"currentPeriodStart":stamp(now-Duration::days(1)),"currentPeriodEnd":stamp(now+Duration::days(29)),"pastDueAt":null}});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        svc.apply_subscription_snapshot(input.clone()).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workspace_entitlements WHERE workspace_id=$1")
            .bind(&actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        svc.apply_subscription_snapshot(input.clone()).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        svc.apply_subscription_snapshot(input.clone())
            .await
            .unwrap()["replayed"],
        true
    );
    let s = &input["snapshot"];
    let refund = json!({"eventId":Uuid::new_v4(),"bodyHash":"b".repeat(64),"refund":{"workspaceId":actor.workspace_id,"environment":"sandbox","orderId":Uuid::new_v4(),"subscriptionId":s["subscriptionId"],"start":s["currentPeriodStart"],"end":s["currentPeriodEnd"],"refundedAt":stamp(now)}});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        svc.apply_period_refund(refund.clone()).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    let history: Value = sqlx::query_scalar(
        "SELECT refunded_periods FROM workspace_entitlements WHERE workspace_id=$1",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(history, json!([]));
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        svc.apply_period_refund(refund.clone()).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        svc.apply_period_refund(refund).await.unwrap()["replayed"],
        true
    );
    let count:(i64,i64,i32)=sqlx::query_as("SELECT (SELECT count(*) FROM billing_event_receipts WHERE workspace_id=$1),(SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action LIKE 'billing.%'),(SELECT jsonb_array_length(refunded_periods) FROM workspace_entitlements WHERE workspace_id=$1)").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, (2, 2, 1));
}
