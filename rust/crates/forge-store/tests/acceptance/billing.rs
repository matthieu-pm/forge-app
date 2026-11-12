use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_core::billing::calendar::{period, stamp};
use forge_store::billing::Service;

struct BillingFixture {
    base: Fixture,
    service: Service,
    thread: Uuid,
    connection: Uuid,
}
impl std::ops::Deref for BillingFixture {
    type Target = Fixture;
    fn deref(&self) -> &Fixture {
        &self.base
    }
}
fn time() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap()
}
fn uuid(value: &Value) -> Uuid {
    value.as_str().unwrap().parse().unwrap()
}
fn trial_input(plan: &str) -> Value {
    json!({"requestId":Uuid::new_v4(),"plan":plan})
}
async fn fixture() -> BillingFixture {
    let f = Fixture::new().await;
    sqlx::query("UPDATE organization SET created_at=$2 WHERE id=$1")
        .bind(&f.actor.workspace_id)
        .bind(time() - Duration::days(120))
        .execute(&f.pool)
        .await
        .unwrap();
    let thread = Uuid::new_v4();
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,runtime_kind) VALUES($1,$2,$3,'eve')")
        .bind(thread).bind(&f.actor.workspace_id).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,created_by_user_id) VALUES($1,$2,'workspace','fixture-provider','managed','forge-native','server-capable','forge-managed','forge-server-vault','Usage fixture','ready',$3)")
        .bind(connection).bind(&f.actor.workspace_id).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO model_catalog_entries(connection_id,selection_id,provider_model_id,display_name,provider_label,source_label,execution_kind) VALUES($1,$2,'fixture-model','Fixture model','Fixture provider','Fixture','forge-native')")
        .bind(connection).bind(format!("{connection}:fixture-model")).execute(&f.pool).await.unwrap();
    BillingFixture {
        service: Service::new(f.database.clone()),
        base: f,
        thread,
        connection,
    }
}
fn admission(f: &BillingFixture, amount: u64) -> Value {
    json!({"requestId":Uuid::new_v4(),"runId":Uuid::new_v4(),"threadId":f.thread,"connectionId":f.connection,"modelId":"fixture-model","maximumCostUsdMicros":amount,"pricingFingerprint":"a".repeat(64)})
}
fn settlement(f: &BillingFixture, run: &Value, outcome: &str, cost: u64) -> Value {
    json!({"workspaceId":f.actor.workspace_id,"reservationId":run,"eventId":Uuid::new_v4(),"outcome":outcome,"providerCostUsdMicros":cost})
}
async fn inspect(f: &BillingFixture) -> Value {
    f.service
        .inspect_usage(&f.actor.workspace_id)
        .await
        .unwrap()
}
async fn paid(f: &BillingFixture, start: DateTime<Utc>, end: DateTime<Utc>) -> String {
    let subscription = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status,source,source_reference,provider_environment,provider_updated_at,provider_state_hash,paid_activated_at,current_period_start,current_period_end) VALUES($1,'basic','active','polar',$2,'sandbox',$3,$4,$3,$3,$5) ON CONFLICT(workspace_id) DO UPDATE SET plan='basic',status='active',source='polar',source_reference=$2,provider_environment='sandbox',provider_updated_at=$3,provider_state_hash=$4,paid_activated_at=$3,current_period_start=$3,current_period_end=$5")
        .bind(&f.actor.workspace_id).bind(&subscription).bind(start).bind("b".repeat(64)).bind(end).execute(&f.pool).await.unwrap();
    subscription
}
async fn historical_trial(f: &Fixture) -> (Uuid, DateTime<Utc>, DateTime<Utc>) {
    let start = time() - Duration::days(15);
    let end = start + Duration::days(14);
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace_trial_redemptions(workspace_id,id,initial_plan,actor_user_id,start_request_id,start_body_hash,started_at,expires_at) VALUES($1,$2,'plus',$3,$4,$5,$6,$7)")
        .bind(&f.actor.workspace_id).bind(id).bind(&f.actor.user_id).bind(Uuid::new_v4()).bind("a".repeat(64)).bind(start).bind(end).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status,source,source_reference,trial_redemption_id,current_period_start,current_period_end) VALUES($1,'business','trialing','forge-trial',$2::uuid::text,$2,$3,$4)")
        .bind(&f.actor.workspace_id).bind(id).bind(start).bind(end).execute(&f.pool).await.unwrap();
    (id, start, end)
}
async fn historical(
    f: &BillingFixture,
    kind: &str,
    binding: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    amount: i64,
) -> (Uuid, Uuid) {
    let account = Uuid::new_v4();
    let run = Uuid::new_v4();
    let source = if kind == "trial" {
        json!({"kind":"trial","trialStartedAt":stamp(start)})
    } else {
        json!({"kind":"paid-monthly","currentPeriodStart":stamp(start),"currentPeriodEnd":stamp(end)})
    };
    let window = period(
        &f.actor.workspace_id,
        start + Duration::milliseconds(1),
        &source,
    )
    .unwrap();
    let key = json!(["forge.usage-account", kind, window["key"]]).to_string();
    sqlx::query("INSERT INTO workspace_usage_periods(id,workspace_id,period_key,kind,binding,started_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(account).bind(&f.actor.workspace_id).bind(key).bind(kind).bind(binding).bind(start).bind(end).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection) VALUES($1,$2,$3,'forge-native','{}')")
        .bind(run).bind(f.thread).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_usage_reservations(id,workspace_id,period_id,request_id,request_hash,operation_id,run_id,actor_user_id,provider,model_id,pricing_fingerprint,billing_mode,uses_pool,maximum_cost_usd_micros,reserved_usd_micros) VALUES($1,$2,$3,$4,$5,$1,$1,$6,'fixture-provider','fixture-model',$5,'forge-managed',true,$7,$7)")
        .bind(run).bind(&f.actor.workspace_id).bind(account).bind(Uuid::new_v4()).bind("a".repeat(64)).bind(&f.actor.user_id).bind(amount).execute(&f.pool).await.unwrap();
    (account, run)
}

#[tokio::test]
async fn trial_starts_serialize_replay_and_lock_the_original_tier_and_window() {
    let f = fixture().await;
    let input = trial_input("starter");
    let (a, b) = tokio::join!(
        f.service.start_trial(&f.actor, input.clone()),
        f.service.start_trial(&f.actor, input.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(a["trial"], b["trial"]);
    let t = &a["trial"];
    assert_eq!(
        forge_core::billing::calendar::date(&t["expiresAt"]).unwrap()
            - forge_core::billing::calendar::date(&t["startedAt"]).unwrap(),
        Duration::days(14)
    );
    assert_eq!(t["allowanceUsdMicros"], 5_000_000);
    assert_eq!(
        f.service
            .start_trial(&f.actor, trial_input("starter"))
            .await
            .unwrap()["trial"],
        *t
    );
    assert_eq!(
        f.service
            .start_trial(&f.actor, trial_input("plus"))
            .await
            .unwrap_err()
            .to_string(),
        "TRIAL_TIER_LOCKED"
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.trial.started'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 1);
    for sql in [
        "DELETE FROM workspace_trial_redemptions WHERE workspace_id=$1",
        "UPDATE workspace_trial_redemptions SET initial_plan='plus' WHERE workspace_id=$1",
        "UPDATE workspace_trial_redemptions SET started_at=started_at+interval '1 hour',expires_at=expires_at+interval '1 hour' WHERE workspace_id=$1",
        "UPDATE workspace_entitlements SET plan='business' WHERE workspace_id=$1",
    ] {
        assert!(
            sqlx::query(sql)
                .bind(&f.actor.workspace_id)
                .execute(&f.pool)
                .await
                .is_err()
        );
    }
    let g = fixture().await;
    assert!(g.service.start_trial(&g.actor, input).await.is_err());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_trial_redemptions WHERE workspace_id=$1",
    )
    .bind(&g.actor.workspace_id)
    .fetch_one(&g.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let h = fixture().await;
    let (a, b) = tokio::join!(
        h.service.start_trial(&h.actor, trial_input("starter")),
        h.service.start_trial(&h.actor, trial_input("plus"))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
}

#[tokio::test]
async fn trial_rechecks_authority_rejects_paid_history_and_expires_without_regrant_or_paid_overwrite()
 {
    let f = fixture().await;
    for extra in [
        json!({"workspaceId":"other"}),
        json!({"startedAt":stamp(time())}),
        json!({"allowanceUsdMicros":10_000_000}),
    ] {
        let mut input = trial_input("plus");
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(f.service.start_trial(&f.actor, input).await.is_err());
    }
    sqlx::query(
        "INSERT INTO workspace_entitlements(workspace_id,paid_activated_at) VALUES($1,now())",
    )
    .bind(&f.actor.workspace_id)
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        f.service
            .start_trial(&f.actor, trial_input("plus"))
            .await
            .unwrap_err()
            .to_string(),
        "TRIAL_NEVER_PAID_REQUIRED"
    );
    let g = fixture().await;
    let input = trial_input("plus");
    g.service
        .start_trial(&g.actor, input.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1")
        .bind(&g.actor.workspace_id)
        .execute(&g.pool)
        .await
        .unwrap();
    assert_eq!(
        g.service
            .start_trial(&g.actor, input)
            .await
            .unwrap_err()
            .to_string(),
        "TRIAL_ACTOR_REVOKED"
    );
    let h = fixture().await;
    let (id, _, _) = historical_trial(&h).await;
    let effective: String = sqlx::query_scalar("SELECT forge_effective_workspace_plan($1)")
        .bind(&h.actor.workspace_id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(effective, "free");
    assert_eq!(
        h.service.expire_trial(&h.actor.workspace_id).await.unwrap(),
        json!({"expired":true})
    );
    assert_eq!(
        h.service.expire_trial(&h.actor.workspace_id).await.unwrap(),
        json!({"expired":false})
    );
    assert_eq!(
        h.service
            .start_trial(&h.actor, trial_input("plus"))
            .await
            .unwrap()["trial"]["id"],
        json!(id)
    );
    let p = fixture().await;
    historical_trial(&p).await;
    paid(&p, time() - Duration::days(1), time() + Duration::days(29)).await;
    assert_eq!(
        p.service.expire_trial(&p.actor.workspace_id).await.unwrap(),
        json!({"expired":false})
    );
    let projection: (String, Option<Uuid>) = sqlx::query_as(
        "SELECT plan,trial_redemption_id FROM workspace_entitlements WHERE workspace_id=$1",
    )
    .bind(&p.actor.workspace_id)
    .fetch_one(&p.pool)
    .await
    .unwrap();
    assert_eq!(projection, ("basic".into(), None));
}

#[tokio::test]
async fn usage_serializes_competing_funds_and_replays_exactly_one_run_event_and_audit() {
    let f = fixture().await;
    let a = admission(&f, 3_000_000);
    let b = admission(&f, 3_000_000);
    let (a, b) = tokio::join!(
        f.service.admit_agent_usage(&f.actor, a),
        f.service.admit_agent_usage(&f.actor, b)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(inspect(&f).await["reservedUsdMicros"], 3_000_000);
    let g = fixture().await;
    let command = admission(&g, 1_000_000);
    let (a, b) = tokio::join!(
        g.service.admit_agent_usage(&g.actor, command.clone()),
        g.service.admit_agent_usage(&g.actor, command.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(a["runId"], b["runId"]);
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM agent_runs WHERE thread_id=$1),(SELECT count(*) FROM agent_events WHERE thread_id=$1),(SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$2 AND action='usage.agent.admitted')").bind(g.thread).bind(&g.actor.workspace_id).fetch_one(&g.pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    let mut changed = command.clone();
    changed["maximumCostUsdMicros"] = json!(1);
    assert_eq!(
        g.service
            .admit_agent_usage(&g.actor, changed)
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_REQUEST_CONFLICT"
    );
    let h = fixture().await;
    let mut cross = admission(&h, 1);
    cross["requestId"] = command["requestId"].clone();
    assert_eq!(
        h.service
            .admit_agent_usage(&h.actor, cross)
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_REQUEST_CONFLICT"
    );
    // Many cheap runs are allowed; allowance is a cost constraint, not a run cap.
    for _ in 0..25 {
        g.service
            .admit_agent_usage(&g.actor, admission(&g, 1_000))
            .await
            .unwrap();
    }
    assert_eq!(inspect(&g).await["reservedUsdMicros"], 1_025_000);
}

#[tokio::test]
async fn usage_rechecks_verified_live_session_membership_guest_policy_and_model_ownership_before_replay()
 {
    let f = fixture().await;
    let g = fixture().await;
    let command = admission(&f, 1_000);
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, admission(&f, 0))
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_BOUNDED_PRICING_REQUIRED"
    );
    assert!(
        f.service
            .admit_agent_usage(&f.actor, admission(&f, forge_core::billing::MAX_SAFE + 1))
            .await
            .is_err()
    );
    let personal = Uuid::new_v4();
    sqlx::query("INSERT INTO model_connections SELECT (jsonb_populate_record(NULL::model_connections,to_jsonb(c)||jsonb_build_object('id',$2::uuid,'user_id',$3::text,'scope','personal'))).* FROM model_connections c WHERE c.id=$1")
        .bind(f.connection).bind(personal).bind(&g.actor.user_id).execute(&f.pool).await.unwrap();
    let mut private = command.clone();
    private["connectionId"] = json!(personal);
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, private)
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_MODEL_CONNECTION_UNAVAILABLE"
    );
    for (key, v, code) in [
        ("threadId", json!(g.thread), "USAGE_THREAD_NOT_FOUND"),
        (
            "connectionId",
            json!(g.connection),
            "USAGE_MODEL_CONNECTION_UNAVAILABLE",
        ),
        ("modelId", json!("missing"), "USAGE_MODEL_UNAVAILABLE"),
    ] {
        let mut changed = command.clone();
        changed[key] = v;
        assert_eq!(
            f.service
                .admit_agent_usage(&f.actor, changed)
                .await
                .unwrap_err()
                .to_string(),
            code
        );
    }
    let mut bad = command.clone();
    bad["plan"] = json!("plus");
    assert!(f.service.admit_agent_usage(&f.actor, bad).await.is_err());
    let mut limited = f.actor.clone();
    limited.scopes = Some(vec![ApiScope::AgentsRead]);
    assert!(
        f.service
            .admit_agent_usage(&limited, command.clone())
            .await
            .is_err()
    );
    limited.scopes = Some(vec![ApiScope::AgentsWrite]);
    limited.authentication = Authentication::ApiKey {
        credential_id: "fixture".into(),
    };
    assert_eq!(
        f.service
            .admit_agent_usage(&limited, command.clone())
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_FIRST_PARTY_SESSION_REQUIRED"
    );
    sqlx::query("UPDATE model_catalog_entries SET expires_at=clock_timestamp()-interval '1 second' WHERE connection_id=$1").bind(f.connection).execute(&f.pool).await.unwrap();
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, command.clone())
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_MODEL_UNAVAILABLE"
    );
    sqlx::query("UPDATE model_catalog_entries SET expires_at=NULL WHERE connection_id=$1")
        .bind(f.connection)
        .execute(&f.pool)
        .await
        .unwrap();
    f.service
        .admit_agent_usage(&f.actor, command.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, command.clone())
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_EMAIL_VERIFICATION_REQUIRED"
    );
    sqlx::query("UPDATE \"user\" SET email_verified=true WHERE id=$1")
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE member SET role='guest' WHERE organization_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,block_guest_agent_access) VALUES($1,true)").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, command.clone())
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_GUEST_AGENT_ACCESS_DENIED"
    );
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, command)
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_ACTOR_REVOKED"
    );
    let command = admission(&g, 1_000);
    g.service
        .admit_agent_usage(&g.actor, command.clone())
        .await
        .unwrap();
    sqlx::query("DELETE FROM member WHERE organization_id=$1")
        .bind(&g.actor.workspace_id)
        .execute(&g.pool)
        .await
        .unwrap();
    assert_eq!(
        g.service
            .admit_agent_usage(&g.actor, command)
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_ACTOR_REVOKED"
    );
}

#[tokio::test]
async fn settlements_retain_uncertain_exposure_replay_receipts_record_overruns_and_keep_byok_outside_pool()
 {
    let f = fixture().await;
    let command = admission(&f, 3_000_000);
    f.service
        .admit_agent_usage(&f.actor, command.clone())
        .await
        .unwrap();
    let uncertain = settlement(&f, &command["runId"], "uncertain", 0);
    assert_eq!(
        f.service.settle_agent_usage(uncertain).await.unwrap()["reservedUsdMicros"],
        3_000_000
    );
    assert_eq!(inspect(&f).await["reservedUsdMicros"], 3_000_000);
    let receipt = settlement(&f, &command["runId"], "settled", 2_000_000);
    let result = f.service.settle_agent_usage(receipt.clone()).await.unwrap();
    assert_eq!(result["state"], "settled");
    assert_eq!(result["reservedUsdMicros"], 0);
    assert_eq!(
        f.service.settle_agent_usage(receipt.clone()).await.unwrap()["replayed"],
        true
    );
    let mut altered = receipt;
    altered["providerCostUsdMicros"] = json!(1);
    assert_eq!(
        f.service
            .settle_agent_usage(altered)
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_SETTLEMENT_CONFLICT"
    );
    assert_eq!(
        f.service
            .settle_agent_usage(settlement(&f, &command["runId"], "settled", 2_000_000))
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_TERMINAL_RECONCILIATION_REQUIRED"
    );
    let release = admission(&f, 3_000_000);
    f.service
        .admit_agent_usage(&f.actor, release.clone())
        .await
        .unwrap();
    assert_eq!(
        f.service
            .settle_agent_usage(settlement(&f, &release["runId"], "confirmed-no-charge", 0))
            .await
            .unwrap()["state"],
        "released"
    );
    let overrun = admission(&f, 1_000_000);
    f.service
        .admit_agent_usage(&f.actor, overrun.clone())
        .await
        .unwrap();
    assert_eq!(
        f.service
            .settle_agent_usage(settlement(&f, &overrun["runId"], "settled", 4_000_000))
            .await
            .unwrap()["state"],
        "reconciliation-required"
    );
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, admission(&f, 1))
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_ALLOWANCE_EXHAUSTED"
    );
    sqlx::query("UPDATE model_connections SET billing_mode='pay-as-you-go' WHERE id=$1")
        .bind(f.connection)
        .execute(&f.pool)
        .await
        .unwrap();
    let byok = admission(&f, 9_000_000);
    f.service
        .admit_agent_usage(&f.actor, byok.clone())
        .await
        .unwrap();
    f.service
        .settle_agent_usage(settlement(&f, &byok["runId"], "settled", 8_000_000))
        .await
        .unwrap();
    assert_eq!(inspect(&f).await["settledUsdMicros"], 6_000_000);
    for sql in [
        "DELETE FROM workspace_usage_reservations WHERE workspace_id=$1",
        "UPDATE workspace_usage_reservations SET uses_pool=false WHERE workspace_id=$1",
        "UPDATE workspace_usage_reservations SET settled_usd_micros=0 WHERE workspace_id=$1",
        "DELETE FROM workspace_usage_periods WHERE workspace_id=$1",
        "UPDATE workspace_usage_receipts SET result='{}' WHERE workspace_id=$1",
    ] {
        assert!(
            sqlx::query(sql)
                .bind(&f.actor.workspace_id)
                .execute(&f.pool)
                .await
                .is_err()
        );
    }
    sqlx::query("DELETE FROM agent_runs WHERE id=$1")
        .bind(uuid(&command["runId"]))
        .execute(&f.pool)
        .await
        .unwrap();
    let retained:(Option<Uuid>,Uuid,i64)=sqlx::query_as("SELECT run_id,operation_id,settled_usd_micros FROM workspace_usage_reservations WHERE id=$1").bind(uuid(&command["runId"])).fetch_one(&f.pool).await.unwrap();
    assert_eq!(retained, (None, uuid(&command["runId"]), 2_000_000));
}

#[tokio::test]
async fn paid_and_trial_accounts_keep_original_commitments_and_carry_into_free_exactly_once() {
    let f = fixture().await;
    let free = admission(&f, 1_500_000);
    f.service
        .admit_agent_usage(&f.actor, free.clone())
        .await
        .unwrap();
    f.service
        .settle_agent_usage(settlement(&f, &free["runId"], "settled", 1_500_000))
        .await
        .unwrap();
    paid(&f, time() - Duration::days(20), time() + Duration::days(10)).await;
    let paid_run = admission(&f, 4_000_000);
    f.service
        .admit_agent_usage(&f.actor, paid_run.clone())
        .await
        .unwrap();
    assert_eq!(inspect(&f).await["settledUsdMicros"], 0);
    sqlx::query("UPDATE workspace_entitlements SET status='canceled',terminated_at=clock_timestamp() WHERE workspace_id=$1").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    let carried = inspect(&f).await;
    assert_eq!(carried["settledUsdMicros"], 1_500_000);
    assert_eq!(carried["reservedUsdMicros"], 4_000_000);
    assert_eq!(carried["carrySourceCount"], 1);
    assert_eq!(inspect(&f).await, carried);
    f.service
        .settle_agent_usage(settlement(&f, &paid_run["runId"], "settled", 2_000_000))
        .await
        .unwrap();
    assert_eq!(inspect(&f).await["settledUsdMicros"], 3_500_000);
    f.service
        .admit_agent_usage(&f.actor, admission(&f, 1_500_000))
        .await
        .unwrap();
    let g = fixture().await;
    let (trial, start, end) = historical_trial(&g).await;
    let (_, run) = historical(&g, "trial", &trial.to_string(), start, end, 5_000_000).await;
    assert_eq!(inspect(&g).await["carrySourceCount"], 1);
    assert_eq!(inspect(&g).await["reservedUsdMicros"], 5_000_000);
    assert_eq!(
        g.service
            .admit_agent_usage(&g.actor, admission(&g, 1))
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_ALLOWANCE_EXHAUSTED"
    );
    g.service
        .settle_agent_usage(settlement(&g, &json!(run), "settled", 3_000_000))
        .await
        .unwrap();
    assert_eq!(inspect(&g).await["settledUsdMicros"], 3_000_000);
    g.service
        .admit_agent_usage(&g.actor, admission(&g, 2_000_000))
        .await
        .unwrap();
    let h = fixture().await;
    h.service
        .admit_agent_usage(&h.actor, admission(&h, 4_000_000))
        .await
        .unwrap();
    h.service
        .start_trial(&h.actor, trial_input("plus"))
        .await
        .unwrap();
    h.service
        .admit_agent_usage(&h.actor, admission(&h, 5_000_000))
        .await
        .unwrap();
    assert_eq!(inspect(&h).await["kind"], "trial");
    assert_eq!(inspect(&h).await["reservedUsdMicros"], 5_000_000);
}

#[tokio::test]
async fn renewal_grace_and_late_downgrade_never_move_old_debt_or_grant_an_extra_pool() {
    let f = fixture().await;
    let start = time() - Duration::days(20);
    let end = time() + Duration::days(10);
    let subscription = paid(&f, start, end).await;
    let binding = json!(["polar", "sandbox", subscription]).to_string();
    let (old, run) = historical(
        &f,
        "paid",
        &binding,
        start - Duration::days(30),
        start,
        5_000_000,
    )
    .await;
    let current = f
        .service
        .admit_agent_usage(&f.actor, admission(&f, 3_000_000))
        .await
        .unwrap();
    assert_ne!(current["periodId"], json!(old));
    f.service
        .settle_agent_usage(settlement(&f, &json!(run), "settled", 4_000_000))
        .await
        .unwrap();
    assert_eq!(inspect(&f).await["settledUsdMicros"], 0);
    sqlx::query("UPDATE workspace_entitlements SET status='past_due',payment_failed_at=date_trunc('milliseconds',statement_timestamp())-interval '1 day',grace_expires_at=date_trunc('milliseconds',statement_timestamp())+interval '6 days' WHERE workspace_id=$1").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(inspect(&f).await["periodId"], current["periodId"]);
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, admission(&f, 3_000_000))
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_ALLOWANCE_EXHAUSTED"
    );
    let g = fixture().await;
    let end = time() - Duration::days(35);
    let start = end - Duration::days(30);
    let subscription = paid(&g, start, end).await;
    let (_, run) = historical(
        &g,
        "paid",
        &json!(["polar", "sandbox", subscription]).to_string(),
        start,
        end,
        5_000_000,
    )
    .await;
    assert_eq!(inspect(&g).await["carrySourceCount"], 0);
    assert_eq!(inspect(&g).await["reservedUsdMicros"], 0);
    g.service
        .settle_agent_usage(settlement(&g, &json!(run), "settled", 5_000_000))
        .await
        .unwrap();
    assert_eq!(inspect(&g).await["settledUsdMicros"], 0);
    let effective: DateTime<Utc> = sqlx::query_scalar(
        "SELECT effective_at FROM workspace_usage_carryovers WHERE workspace_id=$1",
    )
    .bind(&g.actor.workspace_id)
    .fetch_one(&g.pool)
    .await
    .unwrap();
    assert_eq!(effective, end);
    g.service
        .admit_agent_usage(&g.actor, admission(&g, 5_000_000))
        .await
        .unwrap();
}

#[tokio::test]
async fn usage_tracks_active_paid_capacity_and_rolls_back_all_admission_effects_if_the_audit_fails()
{
    let f = fixture().await;
    paid(&f, time() - Duration::days(1), time() + Duration::days(29)).await;
    let visitor = Fixture::new().await;
    enter_workspace(&f, &visitor).await;
    let command = admission(&f, 8_000_000);
    f.service
        .admit_agent_usage(&f.actor, command.clone())
        .await
        .unwrap();
    f.service
        .settle_agent_usage(settlement(&f, &command["runId"], "settled", 8_000_000))
        .await
        .unwrap();
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&visitor.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.service
            .admit_agent_usage(&f.actor, admission(&f, 1))
            .await
            .unwrap_err()
            .to_string(),
        "USAGE_ALLOWANCE_EXHAUSTED"
    );
    let g = fixture().await;
    let command = admission(&g, 1_000);
    let trigger = format!("billing_fixture_{}", Uuid::new_v4().simple());
    // Generated identifiers/UUID workspace only; this is a disposable fixture.
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{}' AND NEW.action='usage.agent.admitted' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$",g.actor.workspace_id)).execute(&g.pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE INSERT ON workspace_security_audit_events FOR EACH ROW EXECUTE FUNCTION {trigger}()" )).execute(&g.pool).await.unwrap();
    let rejected = g.service.admit_agent_usage(&g.actor, command.clone()).await;
    let counts:(i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM workspace_usage_periods WHERE workspace_id=$1),(SELECT count(*) FROM workspace_usage_reservations WHERE workspace_id=$1),(SELECT count(*) FROM agent_runs WHERE thread_id=$2),(SELECT count(*) FROM agent_events WHERE thread_id=$2)").bind(&g.actor.workspace_id).bind(g.thread).fetch_one(&g.pool).await.unwrap();
    sqlx::query(&format!(
        "DROP TRIGGER {trigger} ON workspace_security_audit_events"
    ))
    .execute(&g.pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION {trigger}()"))
        .execute(&g.pool)
        .await
        .unwrap();
    assert!(rejected.is_err());
    assert_eq!(counts, (0, 0, 0, 0));
    g.service
        .admit_agent_usage(&g.actor, command)
        .await
        .unwrap();
}
