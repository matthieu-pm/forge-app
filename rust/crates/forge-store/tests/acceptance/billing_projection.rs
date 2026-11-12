use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_core::{
    billing::calendar::{date, stamp},
    subscription::{SubscriptionState, subscription_access},
};
use forge_store::billing::Service;
fn at() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap()
}
fn event(f: &Fixture) -> Value {
    let now = at();
    json!({"eventId":Uuid::new_v4(),"bodyHash":"a".repeat(64),"snapshot":{"workspaceId":f.actor.workspace_id,"environment":"sandbox","subscriptionId":Uuid::new_v4(),"plan":"starter","status":"active","updatedAt":stamp(now-Duration::days(9)),"currentPeriodStart":stamp(now-Duration::days(10)),"currentPeriodEnd":stamp(now+Duration::days(20)),"pastDueAt":null}})
}
fn next(v: &Value) -> Value {
    let mut v = v.clone();
    v["eventId"] = json!(Uuid::new_v4());
    let updated = date(&v["snapshot"]["updatedAt"]).unwrap() + Duration::seconds(1);
    v["snapshot"]["updatedAt"] = json!(stamp(updated));
    v
}
fn proof(v: &Value) -> Value {
    let s = &v["snapshot"];
    json!({"orderId":Uuid::new_v4(),"subscriptionId":s["subscriptionId"],"periodStart":s["currentPeriodStart"],"periodEnd":s["currentPeriodEnd"],"createdAt":stamp(date(&s["currentPeriodStart"]).unwrap()+Duration::days(1))})
}
fn refund(v: &Value) -> Value {
    let s = &v["snapshot"];
    json!({"eventId":Uuid::new_v4(),"bodyHash":"b".repeat(64),"refund":{"workspaceId":s["workspaceId"],"environment":s["environment"],"orderId":Uuid::new_v4(),"subscriptionId":s["subscriptionId"],"start":s["currentPeriodStart"],"end":s["currentPeriodEnd"],"refundedAt":stamp(at())}})
}
async fn state(f: &Fixture) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
async fn counts(f: &Fixture) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM workspace_entitlements WHERE workspace_id=$1),(SELECT count(*) FROM billing_event_receipts WHERE workspace_id=$1),(SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action LIKE 'billing.%')").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap()
}
fn access(s: Value) -> Value {
    serde_json::to_value(subscription_access(
        SubscriptionState::from_json(s).as_ref(),
        Some(at()),
    ))
    .unwrap()
}
#[tokio::test]
async fn subscription_projection_serializes_initial_activation_and_binds_receipt_version_and_subscription()
 {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = event(&f);
    let (a, b) = tokio::join!(
        svc.apply_subscription_snapshot(input.clone()),
        svc.apply_subscription_snapshot(input.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(a["effectivePlan"], "basic");
    assert_eq!(counts(&f).await, (1, 1, 1));
    let mut conflict = input.clone();
    conflict["bodyHash"] = json!("b".repeat(64));
    assert_eq!(
        svc.apply_subscription_snapshot(conflict)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_EVENT_CONFLICT"
    );
    let mut conflict = input.clone();
    conflict["eventId"] = json!(Uuid::new_v4());
    conflict["snapshot"]["plan"] = json!("plus");
    assert_eq!(
        svc.apply_subscription_snapshot(conflict)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_VERSION_CONFLICT"
    );
    let mut stale = input.clone();
    stale["eventId"] = json!(Uuid::new_v4());
    stale["snapshot"]["updatedAt"] = stale["snapshot"]["currentPeriodStart"].clone();
    assert_eq!(
        svc.apply_subscription_snapshot(stale).await.unwrap()["outcome"],
        "stale"
    );
    let mut conflict = next(&input);
    conflict["snapshot"]["subscriptionId"] = json!(Uuid::new_v4());
    assert_eq!(
        svc.apply_subscription_snapshot(conflict)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_SUBSCRIPTION_CONFLICT"
    );
    let g = Fixture::new().await;
    let other = Service::new(g.database.clone());
    let mut rebound = next(&input);
    rebound["snapshot"]["workspaceId"] = json!(g.actor.workspace_id);
    assert!(matches!(
        other.apply_subscription_snapshot(rebound).await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(counts(&g).await, (0, 0, 0));
    assert_eq!(counts(&f).await, (1, 2, 1));
}
#[tokio::test]
async fn plan_confirmation_rechecks_current_admin_before_cached_replay_and_uses_actual_access() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let mut input = event(&f);
    input["actor"] = json!(f.actor);
    input["planChange"] = json!({"target":"plus","status":"applied","effectiveAt":input["snapshot"]["currentPeriodEnd"],"renewalSeats":2});
    assert_eq!(
        svc.apply_subscription_snapshot(input.clone())
            .await
            .unwrap()["effectivePlan"],
        "basic"
    );
    let after:Value=sqlx::query_scalar("SELECT \"after\" FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.plan_change.confirmed'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(after["status"], "payment-pending");
    assert!(after["effectiveAt"].is_null());
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.apply_subscription_snapshot(input.clone())
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_REVOKED"
    );
    let mut wrong = input.clone();
    wrong["actor"]["workspaceId"] = json!("other");
    assert_eq!(
        svc.apply_subscription_snapshot(wrong)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_WORKSPACE_MISMATCH"
    );
    input.as_object_mut().unwrap().remove("actor");
    assert_eq!(
        svc.apply_subscription_snapshot(input)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_REQUIRED"
    );
    assert_eq!(counts(&f).await, (1, 1, 2));
}
#[tokio::test]
async fn paid_upgrade_can_promote_a_cached_event_but_early_downgrade_preserves_the_paid_contract() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let initial = event(&f);
    svc.apply_subscription_snapshot(initial.clone())
        .await
        .unwrap();
    let mut plus = next(&initial);
    plus["snapshot"]["plan"] = json!("plus");
    assert_eq!(
        svc.apply_subscription_snapshot(plus.clone()).await.unwrap()["effectivePlan"],
        "basic"
    );
    let payment = proof(&plus);
    plus["snapshot"]["paidUpgrade"] = payment.clone();
    assert_eq!(
        svc.apply_subscription_snapshot(plus.clone()).await.unwrap(),
        json!({"outcome":"applied","replayed":true,"effectivePlan":"business"})
    );
    assert_eq!(state(&f).await["paid_upgrade_order_id"], payment["orderId"]);
    let before = counts(&f).await;
    svc.apply_subscription_snapshot(plus.clone()).await.unwrap();
    assert_eq!(counts(&f).await, before);
    let mut down = next(&plus);
    down["snapshot"]["plan"] = json!("starter");
    down["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("paidUpgrade");
    assert_eq!(
        svc.apply_subscription_snapshot(down.clone()).await.unwrap()["effectivePlan"],
        "business"
    );
    down = next(&down);
    down["snapshot"]["currentPeriodStart"] = down["snapshot"]["currentPeriodEnd"].clone();
    down["snapshot"]["currentPeriodEnd"] = json!(stamp(
        date(&down["snapshot"]["currentPeriodStart"]).unwrap() + Duration::days(30)
    ));
    svc.apply_subscription_snapshot(down).await.unwrap();
    assert_eq!(state(&f).await["plan"], "basic");
    assert!(state(&f).await["paid_upgrade_order_id"].is_null());
}
#[tokio::test]
async fn stale_termination_and_pause_are_restrictive_and_ordinary_snapshots_cannot_clear_them() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let initial = event(&f);
    svc.apply_subscription_snapshot(initial.clone())
        .await
        .unwrap();
    let mut terminal = initial.clone();
    terminal["snapshot"]["status"] = json!("canceled");
    terminal["snapshot"]["terminatedAt"] = initial["snapshot"]["currentPeriodStart"].clone();
    assert_eq!(
        svc.apply_subscription_snapshot(terminal.clone())
            .await
            .unwrap()["effectivePlan"],
        "free"
    );
    let before = counts(&f).await;
    svc.apply_subscription_snapshot(terminal).await.unwrap();
    assert_eq!(counts(&f).await, before);
    assert_eq!(
        svc.apply_subscription_snapshot(next(&initial))
            .await
            .unwrap()["outcome"],
        "unchanged"
    );
    assert_eq!(access(state(&f).await)["plan"], "free");
    let g = Fixture::new().await;
    let svc = Service::new(g.database.clone());
    let initial = event(&g);
    svc.apply_subscription_snapshot(initial.clone())
        .await
        .unwrap();
    let mut paused = initial.clone();
    paused["snapshot"]["unsupportedPauseAt"] = initial["snapshot"]["currentPeriodEnd"].clone();
    svc.apply_subscription_snapshot(paused.clone())
        .await
        .unwrap();
    let mut earlier = paused.clone();
    earlier["eventId"] = json!(Uuid::new_v4());
    earlier["snapshot"]["unsupportedPauseAt"] = initial["snapshot"]["currentPeriodStart"].clone();
    svc.apply_subscription_snapshot(earlier).await.unwrap();
    assert_eq!(
        svc.apply_subscription_snapshot(next(&initial))
            .await
            .unwrap()["effectivePlan"],
        "free"
    );
    assert_eq!(
        date(&state(&g).await["unsupported_pause_at"]).unwrap(),
        date(&initial["snapshot"]["currentPeriodStart"]).unwrap()
    );
}
#[tokio::test]
async fn grace_preserves_first_failure_and_refunded_paid_proof_cannot_restart_it() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let initial = event(&f);
    svc.apply_subscription_snapshot(initial.clone())
        .await
        .unwrap();
    let mut failed = next(&initial);
    failed["snapshot"]["status"] = json!("past_due");
    failed["snapshot"]["updatedAt"] = json!(stamp(at()));
    failed["snapshot"]["pastDueAt"] = json!(stamp(at() - Duration::days(2)));
    svc.apply_subscription_snapshot(failed.clone())
        .await
        .unwrap();
    let first = state(&f).await;
    assert_eq!(access(first.clone())["phase"], "grace");
    let mut retry = next(&failed);
    retry["snapshot"]["pastDueAt"] = json!(stamp(at() - Duration::days(1)));
    svc.apply_subscription_snapshot(retry.clone())
        .await
        .unwrap();
    let repeated = state(&f).await;
    assert_eq!(first["payment_failed_at"], repeated["payment_failed_at"]);
    assert_eq!(first["grace_expires_at"], repeated["grace_expires_at"]);
    let mut cancel = next(&retry);
    cancel["snapshot"]["status"] = json!("canceled");
    cancel["snapshot"]["cancelAtPeriodEnd"] = json!(true);
    svc.apply_subscription_snapshot(cancel.clone())
        .await
        .unwrap();
    assert_eq!(state(&f).await["status"], "past_due");
    assert_eq!(
        state(&f).await["grace_expires_at"],
        first["grace_expires_at"]
    );
    svc.apply_period_refund(refund(&initial)).await.unwrap();
    let mut failed = next(&cancel);
    failed["snapshot"]["status"] = json!("past_due");
    svc.apply_subscription_snapshot(failed.clone())
        .await
        .unwrap();
    let revoked = state(&f).await;
    assert!(revoked["paid_activated_at"].is_null());
    assert!(revoked["grace_expires_at"].is_null());
    assert_eq!(access(revoked)["plan"], "free");
    svc.apply_subscription_snapshot(next(&failed))
        .await
        .unwrap();
    assert!(state(&f).await["grace_expires_at"].is_null());
}
#[tokio::test]
async fn refunds_are_serialized_replayable_and_restore_only_verified_starter_basis() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let mut initial = event(&f);
    initial["snapshot"]["plan"] = json!("plus");
    let payment = proof(&initial);
    initial["snapshot"]["paidUpgrade"] = payment.clone();
    svc.apply_subscription_snapshot(initial.clone())
        .await
        .unwrap();
    let mut partial = refund(&initial);
    partial["refund"]["kind"] = json!("partial");
    assert_eq!(
        svc.apply_period_refund(partial.clone()).await.unwrap()["outcome"],
        "unchanged"
    );
    assert_eq!(state(&f).await["refunded_periods"], json!([]));
    let count = counts(&f).await;
    svc.apply_period_refund(partial).await.unwrap();
    assert_eq!(counts(&f).await, count);
    let mut r = refund(&initial);
    r["refund"]["scope"] = json!("upgrade");
    r["refund"]["orderId"] = payment["orderId"].clone();
    let (a, b) = tokio::join!(
        svc.apply_period_refund(r.clone()),
        svc.apply_period_refund(r.clone())
    );
    assert_ne!(a.unwrap()["replayed"], b.unwrap()["replayed"]);
    assert_eq!(state(&f).await["plan"], "basic");
    assert_eq!(access(state(&f).await)["plan"], "free");
    r["refund"]["starterBasis"] =
        json!({"orderId":Uuid::new_v4(),"start":r["refund"]["start"],"end":r["refund"]["end"]});
    assert_eq!(
        svc.apply_period_refund(r.clone()).await.unwrap(),
        json!({"outcome":"applied","replayed":true})
    );
    assert_eq!(access(state(&f).await)["plan"], "basic");
    assert_eq!(
        state(&f).await["refunded_periods"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let before = counts(&f).await;
    svc.apply_period_refund(r.clone()).await.unwrap();
    assert_eq!(counts(&f).await, before);
    let mut altered = r.clone();
    altered["eventId"] = json!(Uuid::new_v4());
    altered["refund"]["start"] = json!(
        r["refund"]["start"]
            .as_str()
            .unwrap()
            .replace('Z', "+00:00")
    );
    assert_eq!(
        svc.apply_period_refund(altered)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_REFUND_CONFLICT"
    );
    assert_eq!(
        svc.apply_subscription_snapshot(next(&initial))
            .await
            .unwrap()["effectivePlan"],
        "basic"
    );
    let full = refund(&initial);
    svc.apply_period_refund(full).await.unwrap();
    assert_eq!(access(state(&f).await)["plan"], "free");
}
#[tokio::test]
async fn projection_audit_failure_rolls_back_state_receipt_and_refund_and_preserves_insert_constraints()
 {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let initial = event(&f);
    let trigger = format!("billing_projection_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{}' AND NEW.action LIKE 'billing.%' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$",f.actor.workspace_id)).execute(&f.pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE INSERT ON workspace_security_audit_events FOR EACH ROW EXECUTE FUNCTION {trigger}()" )).execute(&f.pool).await.unwrap();
    let subscription = svc.apply_subscription_snapshot(initial.clone()).await;
    let refund = svc.apply_period_refund(refund(&initial)).await;
    let observed = counts(&f).await;
    sqlx::query(&format!(
        "DROP TRIGGER {trigger} ON workspace_security_audit_events"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION {trigger}()"))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(subscription.is_err());
    assert!(refund.is_err());
    assert_eq!(observed, (0, 0, 0));
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id) VALUES($1)")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut pause = initial;
    pause["snapshot"]["unsupportedPauseAt"] = pause["snapshot"]["currentPeriodStart"].clone();
    assert!(matches!(
        svc.apply_subscription_snapshot(pause).await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(state(&f).await["source"], "internal");
    assert_eq!(counts(&f).await, (1, 0, 0));
}
