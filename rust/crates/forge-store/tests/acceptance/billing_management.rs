use super::*;
use chrono::{Datelike, Duration, Utc};
use forge_core::billing::calendar::{date, next_month, stamp};
use forge_store::billing::Service;
async fn paid(f: &Fixture) -> Value {
    let start = Utc::now()
        .date_naive()
        .with_day(1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let end = next_month(start, 1).unwrap();
    let subscription = Uuid::new_v4();
    Service::new(f.database.clone()).apply_subscription_snapshot(json!({"eventId":Uuid::new_v4(),"bodyHash":"a".repeat(64),"snapshot":{"workspaceId":f.actor.workspace_id,"environment":"sandbox","subscriptionId":subscription,"plan":"starter","status":"active","updatedAt":stamp(start),"currentPeriodStart":stamp(start),"currentPeriodEnd":stamp(end),"pastDueAt":null}})).await.unwrap();
    json!({"requestId":Uuid::new_v4(),"workspaceId":f.actor.workspace_id,"environment":"sandbox","subscriptionId":subscription,"billingCountry":"FR","fromCurrency":"usd","currentPlan":"starter","renewalPlan":"starter","periodStart":stamp(start),"periodEnd":stamp(end),"providerUpdatedAt":stamp(Utc::now())})
}
async fn refund_context(f: &Fixture, input: &Value) -> (Value, Value) {
    let svc = Service::new(f.database.clone());
    let order = Uuid::new_v4();
    svc.apply_period_refund(json!({"eventId":Uuid::new_v4(),"bodyHash":"b".repeat(64),"refund":{"scope":"upgrade","starterBasis":{"orderId":Uuid::new_v4(),"start":input["periodStart"],"end":input["periodEnd"]},"workspaceId":f.actor.workspace_id,"environment":"sandbox","orderId":order,"subscriptionId":input["subscriptionId"],"start":input["periodStart"],"end":input["periodEnd"],"refundedAt":stamp(Utc::now())}})).await.unwrap();
    let identity = json!({"workspaceId":f.actor.workspace_id,"environment":"sandbox","subscriptionId":input["subscriptionId"],"orderId":order});
    let context = svc
        .upgrade_refund_renewal_context(identity.clone())
        .await
        .unwrap();
    let proof = json!({"revision":context["revision"],"effectiveAt":context["end"],"providerUpdatedAt":stamp(Utc::now()),"currency":"usd","productId":Uuid::new_v4(),"billedSeats":1,"renewalSeats":1,"status":"scheduled"});
    (identity, proof)
}
async fn history(f: &Fixture) -> Vec<Value> {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM workspace_currency_change_requests r WHERE workspace_id=$1 ORDER BY requested_at,id").bind(&f.actor.workspace_id).fetch_all(&f.pool).await.unwrap()
}
async fn receipts(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM billing_event_receipts WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
#[tokio::test]
async fn billing_contexts_require_live_admin_paid_access_and_count_all_accepted_roles() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    assert_eq!(
        svc.cancellation_context(&f.actor, "sandbox").await.unwrap()["subscriptionId"],
        input["subscriptionId"]
    );
    assert_eq!(
        svc.plan_change_context(&f.actor, "sandbox").await.unwrap(),
        json!({"workspaceId":f.actor.workspace_id,"subscriptionId":input["subscriptionId"],"billableMembers":1,"projectedPlan":"starter","refundedUpgrade":false})
    );
    assert_eq!(svc.count_billable_members(&f.actor).await.unwrap(), 1);
    let g = Fixture::new().await;
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'guest')")
        .bind(Uuid::new_v4().to_string())
        .bind(&f.actor.workspace_id)
        .bind(&g.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(svc.count_billable_members(&f.actor).await.unwrap(), 2);
    assert_eq!(
        svc.cancellation_context(&f.actor, "production")
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_SUBSCRIPTION_NOT_FOUND"
    );
    sqlx::query("UPDATE workspace_entitlements SET unsupported_pause_at=current_period_end WHERE workspace_id=$1").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        svc.plan_change_context(&f.actor, "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_PAID_PLAN_REQUIRED"
    );
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.cancellation_context(&f.actor, "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_REVOKED"
    );
}
#[tokio::test]
async fn currency_request_races_replay_original_quote_and_bind_hash_to_workspace_and_actor() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let mut input = paid(&f).await;
    input["requestId"] = json!(input["requestId"].as_str().unwrap().to_uppercase());
    let (a, b) = tokio::join!(
        svc.record_renewal_currency_request(&f.actor, input.clone()),
        svc.record_renewal_currency_request(&f.actor, input.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(a["id"], input["requestId"].as_str().unwrap().to_lowercase());
    assert_eq!(a["status"], "requires-checkout");
    assert_eq!(a["renewalPriceMinor"], 1000);
    assert_eq!(a["providerChangeScheduled"], false);
    assert_eq!(
        date(&a["checkoutGraceEndsAt"]).unwrap() - date(&a["effectiveAt"]).unwrap(),
        Duration::days(7)
    );
    assert_eq!(history(&f).await.len(), 1);
    assert_eq!(receipts(&f).await, 2);
    let mut fresh = input.clone();
    fresh["providerUpdatedAt"] = json!(stamp(Utc::now() + Duration::seconds(1)));
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, fresh)
            .await
            .unwrap()["replayed"],
        true
    );
    let mut conflict = input.clone();
    conflict["billingCountry"] = json!("US");
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, conflict)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_EVENT_CONFLICT"
    );
    let g = Fixture::new().await;
    let mut other = paid(&g).await;
    other["requestId"] = input["requestId"].clone();
    assert_eq!(
        Service::new(g.database.clone())
            .record_renewal_currency_request(&g.actor, other)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_EVENT_CONFLICT"
    );
    assert!(history(&g).await.is_empty());
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, input)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_REVOKED"
    );
}
#[tokio::test]
async fn currency_replacement_uses_current_seats_withdrawal_and_one_immutable_month_anchor() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    svc.record_renewal_currency_request(&f.actor, input.clone())
        .await
        .unwrap();
    let g = Fixture::new().await;
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')")
        .bind(Uuid::new_v4().to_string())
        .bind(&f.actor.workspace_id)
        .bind(&g.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut replacement = input.clone();
    replacement["requestId"] = json!(Uuid::new_v4());
    replacement["renewalPlan"] = json!("plus");
    let answer = svc
        .record_renewal_currency_request(&f.actor, replacement.clone())
        .await
        .unwrap();
    assert_eq!(answer["renewalMembers"], 2);
    assert_eq!(answer["renewalPriceMinor"], 3200);
    let rows = history(&f).await;
    assert_eq!(rows.iter().filter(|r| r["state"] == "requested").count(), 1);
    assert_eq!(
        rows.iter().filter(|r| r["state"] == "superseded").count(),
        1
    );
    sqlx::query("UPDATE workspace_currency_change_requests SET original_period_start=NULL,billing_anchor_day=NULL,next_renewal_at=NULL WHERE id=$1").bind(replacement["requestId"].as_str().unwrap().parse::<Uuid>().unwrap()).execute(&f.pool).await.unwrap();
    let captured = svc
        .record_renewal_currency_request(&f.actor, replacement.clone())
        .await
        .unwrap();
    assert_eq!(captured["billingAnchorDay"], 1);
    assert_eq!(captured["replayed"], true);
    svc.record_renewal_currency_request(&f.actor, replacement.clone())
        .await
        .unwrap();
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.currency_change.anchor_captured'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(audits, 1);
    let mut withdraw = input;
    withdraw["requestId"] = json!(Uuid::new_v4());
    withdraw["billingCountry"] = json!("US");
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, withdraw.clone())
            .await
            .unwrap()["status"],
        "withdrawn"
    );
    assert!(!history(&f).await.iter().any(|r| r["state"] == "requested"));
    withdraw["requestId"] = json!(Uuid::new_v4());
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, withdraw)
            .await
            .unwrap()["status"],
        "unchanged"
    );
    sqlx::query("UPDATE workspace_currency_change_requests SET billing_anchor_day=31 WHERE id=$1")
        .bind(
            replacement["requestId"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        )
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, replacement)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ANCHOR_RECONCILIATION_REQUIRED"
    );
}
#[tokio::test]
async fn currency_replay_requires_fresh_paid_context_and_pending_binding_never_silently_moves() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    svc.record_renewal_currency_request(&f.actor, input.clone())
        .await
        .unwrap();
    let mut invalid = input.clone();
    invalid["providerUpdatedAt"] = json!(stamp(
        date(&input["periodStart"]).unwrap() - Duration::seconds(1)
    ));
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, invalid)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_CURRENCY_CONTEXT_CHANGED"
    );
    let mut changed = input.clone();
    changed["requestId"] = json!(Uuid::new_v4());
    changed["periodEnd"] = json!(stamp(
        date(&input["periodEnd"]).unwrap() + Duration::days(1)
    ));
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, changed)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_CURRENCY_CONTEXT_CHANGED"
    );
    // A one-day shift is a valid candidate monthly anchor in the owning policy,
    // but it differs from the paid binding. A two-month span is not an anchor.
    let mut nonmonthly = input.clone();
    nonmonthly["requestId"] = json!(Uuid::new_v4());
    nonmonthly["periodEnd"] = json!(stamp(
        date(&input["periodEnd"]).unwrap() + Duration::days(32)
    ));
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, nonmonthly)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ANCHOR_RECONCILIATION_REQUIRED"
    );
    sqlx::query(
        "UPDATE workspace_currency_change_requests SET subscription_id=$2 WHERE workspace_id=$1",
    )
    .bind(&f.actor.workspace_id)
    .bind(Uuid::new_v4())
    .execute(&f.pool)
    .await
    .unwrap();
    let mut next = input.clone();
    next["requestId"] = json!(Uuid::new_v4());
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, next)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_CURRENCY_REQUEST_RECONCILIATION_REQUIRED"
    );
    assert_eq!(receipts(&f).await, 2);
    sqlx::query("UPDATE workspace_entitlements SET terminated_at=now() WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.record_renewal_currency_request(&f.actor, input)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_CURRENCY_CONTEXT_CHANGED"
    );
}
#[tokio::test]
async fn refund_renewal_confirmation_is_revision_bound_idempotent_and_never_changes_entitlements() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    let (identity, proof) = refund_context(&f, &input).await;
    assert_eq!(
        svc.plan_change_context(&f.actor, "sandbox").await.unwrap()["refundedUpgrade"],
        true
    );
    let before: Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1",
    )
    .bind(&f.actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let (a, b) = tokio::join!(
        svc.confirm_upgrade_refund_renewal(identity.clone(), proof.clone()),
        svc.confirm_upgrade_refund_renewal(identity.clone(), proof.clone())
    );
    assert_ne!(a.unwrap()["replayed"], b.unwrap()["replayed"]);
    let after: Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1",
    )
    .bind(&f.actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(receipts(&f).await, 3);
    let mut conflict = proof.clone();
    conflict["currency"] = json!("eur");
    assert_eq!(
        svc.confirm_upgrade_refund_renewal(identity.clone(), conflict)
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_EVENT_CONFLICT"
    );
    sqlx::query("UPDATE workspace_entitlements SET refunded_periods=jsonb_set(refunded_periods,'{0,refundedAt}',$2::jsonb) WHERE workspace_id=$1").bind(&f.actor.workspace_id).bind(json!(stamp(Utc::now()-Duration::seconds(10)))).execute(&f.pool).await.unwrap();
    assert_eq!(
        svc.confirm_upgrade_refund_renewal(identity.clone(), proof.clone())
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_REFUND_RENEWAL_CONTEXT_CHANGED"
    );
    sqlx::query("UPDATE workspace_entitlements SET terminated_at=now() WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.confirm_upgrade_refund_renewal(identity, proof)
            .await
            .unwrap(),
        json!({"status":"terminated","replayed":false})
    );
    assert_eq!(receipts(&f).await, 3);
}
#[tokio::test]
async fn management_audit_failure_rolls_back_supersession_and_confirmation_receipts() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    svc.record_renewal_currency_request(&f.actor, input.clone())
        .await
        .unwrap();
    let (identity, proof) = refund_context(&f, &input).await;
    let old_rows = history(&f).await;
    let old_receipts = receipts(&f).await;
    let trigger = format!("billing_management_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{}' AND NEW.action IN ('billing.currency_change.requested','billing.upgrade_refund.renewal_confirmed') THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$",f.actor.workspace_id)).execute(&f.pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE INSERT ON workspace_security_audit_events FOR EACH ROW EXECUTE FUNCTION {trigger}()" )).execute(&f.pool).await.unwrap();
    let mut next = input;
    next["requestId"] = json!(Uuid::new_v4());
    let currency = svc.record_renewal_currency_request(&f.actor, next).await;
    let confirmation = svc.confirm_upgrade_refund_renewal(identity, proof).await;
    let rows = history(&f).await;
    let count = receipts(&f).await;
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
    assert!(currency.is_err());
    assert!(confirmation.is_err());
    assert_eq!(rows, old_rows);
    assert_eq!(count, old_receipts);
}

#[tokio::test]
async fn currency_quote_waits_for_an_inflight_membership_capacity_change() {
    let f = Fixture::new().await;
    let g = Fixture::new().await;
    let input = paid(&f).await;
    let mut member_tx = f.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')")
        .bind(Uuid::new_v4().to_string())
        .bind(&f.actor.workspace_id)
        .bind(&g.actor.user_id)
        .execute(&mut *member_tx)
        .await
        .unwrap();
    let svc = Service::new(f.database.clone());
    let actor = f.actor.clone();
    let mut request =
        tokio::spawn(async move { svc.record_renewal_currency_request(&actor, input).await });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(80), &mut request)
            .await
            .is_err()
    );
    member_tx.commit().await.unwrap();
    let answer = request.await.unwrap().unwrap();
    assert_eq!(answer["renewalMembers"], 2);
    assert_eq!(answer["renewalPriceMinor"], 2000);
}
