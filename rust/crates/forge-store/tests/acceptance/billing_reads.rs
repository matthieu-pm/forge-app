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

async fn entitlement(f: &Fixture) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}

fn summary_fields(summary: &Value) {
    let object = summary.as_object().unwrap();
    let names = [
        "plan",
        "phase",
        "activeMembers",
        "notices",
        "trialExpiresAt",
    ];
    assert_eq!(object.len(), names.len());
    assert!(names.iter().all(|name| object.contains_key(*name)));
}

#[tokio::test]
async fn summary_allows_every_session_role_counts_members_and_rechecks_revocation() {
    let f = Fixture::new().await;
    let g = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let member = enter_workspace(&f, &g).await;
    sqlx::query("INSERT INTO invitation(id,organization_id,email,role,expires_at,inviter_id) VALUES($1,$2,'pending@example.test','member',now()+interval '1 day',$3)")
        .bind(Uuid::new_v4().to_string()).bind(&f.actor.workspace_id).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    for role in ["owner", "admin", "member", "guest"] {
        sqlx::query("UPDATE member SET role=$3 WHERE organization_id=$1 AND user_id=$2")
            .bind(&f.actor.workspace_id)
            .bind(&g.actor.user_id)
            .bind(role)
            .execute(&f.pool)
            .await
            .unwrap();
        let summary = svc.billing_summary(&member).await.unwrap();
        summary_fields(&summary);
        assert_eq!(summary["activeMembers"], 2, "{role}");
        assert_eq!(summary["phase"], "free");
        assert_eq!(summary["trialExpiresAt"], Value::Null);
        assert_eq!(summary["notices"][0]["code"], "free-capacity");
    }
    let mut api = member.clone();
    api.authentication = Authentication::ApiKey {
        credential_id: Uuid::new_v4().to_string(),
    };
    assert!(matches!(
        svc.billing_summary(&api).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE session SET expires_at=now()-interval '1 second' WHERE token=$1")
        .bind(&g.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        svc.billing_summary(&member).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE session SET expires_at=now()+interval '1 day',active_organization_id=$2 WHERE token=$1")
        .bind(&g.token).bind(&g.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        svc.billing_summary(&member).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE session SET active_organization_id=$2 WHERE token=$1")
        .bind(&g.token)
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&g.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        svc.billing_summary(&member).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(
        svc.billing_summary(&f.actor).await.unwrap()["activeMembers"],
        1
    );
}

#[tokio::test]
async fn summary_trial_expiry_is_a_read_time_boundary_without_projection_writes() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let trial = svc
        .start_trial(&f.actor, json!({"requestId":Uuid::new_v4(),"plan":"plus"}))
        .await
        .unwrap();
    let before = entitlement(&f).await;
    let end = date(&trial["trial"]["expiresAt"]).unwrap();
    let live = svc
        .billing_summary_at(&f.actor, end - Duration::milliseconds(1))
        .await
        .unwrap();
    summary_fields(&live);
    assert_eq!(live["plan"], "business");
    assert_eq!(live["phase"], "trial");
    assert_eq!(live["trialExpiresAt"], stamp(end));
    assert_eq!(live["notices"][0]["code"], "trial");
    assert_eq!(live["notices"][0]["effectiveAt"], live["trialExpiresAt"]);
    let expired = svc.billing_summary_at(&f.actor, end).await.unwrap();
    assert_eq!(expired["plan"], "free");
    assert_eq!(expired["phase"], "free");
    assert_eq!(expired["trialExpiresAt"], Value::Null);
    assert_eq!(expired["notices"][0]["code"], "free-capacity");
    assert_eq!(entitlement(&f).await, before);
    assert_eq!(before["status"], "trialing");
}

#[tokio::test]
async fn summary_composes_cancellation_and_refund_access_without_exposing_provider_state() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    sqlx::query("UPDATE workspace_entitlements SET cancel_at_period_end=true,cancellation_period_end=current_period_end WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let before = entitlement(&f).await;
    let summary = svc.billing_summary(&f.actor).await.unwrap();
    summary_fields(&summary);
    assert_eq!(summary["phase"], "paid");
    assert_eq!(summary["plan"], "basic");
    assert_eq!(summary["trialExpiresAt"], Value::Null);
    assert_eq!(summary["notices"][0]["code"], "cancellation");
    assert_eq!(summary["notices"][0]["effectiveAt"], input["periodEnd"]);
    assert_eq!(entitlement(&f).await, before);
    svc.apply_period_refund(json!({"eventId":Uuid::new_v4(),"bodyHash":"b".repeat(64),"refund":{"workspaceId":f.actor.workspace_id,"environment":"sandbox","orderId":Uuid::new_v4(),"subscriptionId":input["subscriptionId"],"start":input["periodStart"],"end":input["periodEnd"],"refundedAt":stamp(Utc::now())}})).await.unwrap();
    let refunded = svc.billing_summary(&f.actor).await.unwrap();
    summary_fields(&refunded);
    assert_eq!(refunded["phase"], "free");
    assert_eq!(refunded["plan"], "free");
    assert_eq!(refunded["notices"].as_array().unwrap().len(), 1);
    assert_eq!(refunded["notices"][0]["code"], "free-capacity");
    assert_eq!(
        entitlement(&f).await["refunded_periods"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        !refunded
            .to_string()
            .contains(input["subscriptionId"].as_str().unwrap())
    );
    assert!(
        !summary
            .to_string()
            .contains(before["provider_state_hash"].as_str().unwrap())
    );
}

#[tokio::test]
async fn summary_discards_malformed_access_rows_but_ignores_unread_provider_metadata() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status,source,provider_updated_at,updated_at) VALUES($1,'basic','active','internal','infinity','infinity')")
        .bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        svc.billing_summary(&f.actor).await.unwrap()["phase"],
        "paid"
    );
    sqlx::query("UPDATE workspace_entitlements SET feature_overrides=$2 WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .bind(json!({"sso":"false"}))
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.billing_summary(&f.actor).await.unwrap()["phase"],
        "free"
    );
    sqlx::query("UPDATE workspace_entitlements SET feature_overrides='{}',paid_activated_at='infinity' WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        svc.billing_summary(&f.actor).await.unwrap()["phase"],
        "free"
    );
    sqlx::query("UPDATE workspace_entitlements SET paid_activated_at=NULL WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let valid = json!({"orderId":Uuid::new_v4(),"subscriptionId":Uuid::new_v4(),"environment":"sandbox","start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","refundedAt":"2026-01-12T12:00:00+01:00"});
    let mut cases = vec![];
    let mut malformed = valid.clone();
    malformed["orderId"] = json!(Uuid::new_v4().simple().to_string());
    cases.push(malformed);
    let mut malformed = valid.clone();
    malformed["start"] = json!("2026-01-01T00:00Z");
    cases.push(malformed);
    let mut malformed = valid.clone();
    malformed["basePeriodStart"] = Value::Null;
    cases.push(malformed);
    for malformed in cases {
        sqlx::query("UPDATE workspace_entitlements SET refunded_periods=$2 WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .bind(json!([malformed]))
            .execute(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            svc.billing_summary(&f.actor).await.unwrap()["phase"],
            "free"
        );
    }
    sqlx::query("UPDATE workspace_entitlements SET refunded_periods=$2 WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .bind(json!([valid]))
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.billing_summary(&f.actor).await.unwrap()["phase"],
        "paid"
    );
}

#[tokio::test]
async fn replacement_context_returns_only_the_frozen_request_and_explicit_anniversary() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    let recorded = svc
        .record_renewal_currency_request(&f.actor, input.clone())
        .await
        .unwrap();
    let request = input["requestId"].as_str().unwrap();
    let context = svc
        .replacement_anniversary_context(&f.actor, &request.to_uppercase(), "sandbox")
        .await
        .unwrap();
    assert_eq!(
        context,
        json!({
            "requestId":request,
            "workspaceId":f.actor.workspace_id,
            "environment":"sandbox",
            "sourceSubscriptionId":input["subscriptionId"],
            "targetCurrency":"eur",
            "renewalPlan":"starter",
            "renewalMembers":1,
            "renewalPriceMinor":1000,
            "originalPeriodStart":input["periodStart"],
            "effectiveAt":input["periodEnd"],
            "anchorDay":1,
            "nextRenewalAt":recorded["nextRenewalAt"],
            "checkoutGraceEndsAt":recorded["checkoutGraceEndsAt"]
        })
    );
    let g = Fixture::new().await;
    enter_workspace(&f, &g).await;
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "sandbox")
            .await
            .unwrap(),
        context
    );
    // Schema validation does not recompute or authorize the stored quote; the
    // subsequent provider verifier owns price and calendar consistency.
    sqlx::query(
        "UPDATE workspace_currency_change_requests SET renewal_price_minor=1001 WHERE id=$1",
    )
    .bind(request.parse::<Uuid>().unwrap())
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "sandbox")
            .await
            .unwrap()["renewalPriceMinor"],
        1001
    );
}

#[tokio::test]
async fn replacement_context_rechecks_binding_request_state_legacy_anchor_and_live_admin() {
    let f = Fixture::new().await;
    let svc = Service::new(f.database.clone());
    let input = paid(&f).await;
    svc.record_renewal_currency_request(&f.actor, input.clone())
        .await
        .unwrap();
    let request = input["requestId"].as_str().unwrap();
    let key = request.parse::<Uuid>().unwrap();
    let changed = "BILLING_REPLACEMENT_CONTEXT_CHANGED";
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, &Uuid::new_v4().to_string(), "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        changed
    );
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, "invalid", "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        "INVALID_BILLING_INPUT"
    );
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "production")
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_SUBSCRIPTION_NOT_FOUND"
    );
    let g = Fixture::new().await;
    let other = paid(&g).await;
    Service::new(g.database.clone())
        .record_renewal_currency_request(&g.actor, other.clone())
        .await
        .unwrap();
    assert_eq!(
        svc.replacement_anniversary_context(
            &f.actor,
            other["requestId"].as_str().unwrap(),
            "sandbox"
        )
        .await
        .unwrap_err()
        .to_string(),
        changed
    );
    sqlx::query("UPDATE workspace_currency_change_requests SET subscription_id=$2 WHERE id=$1")
        .bind(key)
        .bind(Uuid::new_v4())
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        changed
    );
    sqlx::query("UPDATE workspace_currency_change_requests SET subscription_id=$2,state='superseded' WHERE id=$1")
        .bind(key).bind(input["subscriptionId"].as_str().unwrap().parse::<Uuid>().unwrap()).execute(&f.pool).await.unwrap();
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        changed
    );
    sqlx::query("UPDATE workspace_currency_change_requests SET state='requested',original_period_start=NULL,billing_anchor_day=NULL,next_renewal_at=NULL WHERE id=$1")
        .bind(key).execute(&f.pool).await.unwrap();
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        "INVALID_BILLING_INPUT"
    );
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    // The live-authority check precedes both request UUID and anchor validation.
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, "invalid", "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_REVOKED"
    );
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        svc.replacement_anniversary_context(&f.actor, request, "sandbox")
            .await
            .unwrap_err()
            .to_string(),
        "BILLING_ACTOR_REVOKED"
    );
}
