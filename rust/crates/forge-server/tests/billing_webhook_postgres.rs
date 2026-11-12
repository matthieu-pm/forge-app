use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{Request as HttpRequest, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use forge_core::{
    billing::{calendar::stamp, configuration::Enabled},
    features::FeatureRollouts,
    subscription::{SubscriptionState, subscription_access},
};
use forge_server::{
    billing::Settings,
    billing_provider::{Client, Error, Request, Transport, reconciliation::Reconciler},
    router_with_state,
    state::AppState,
};
use forge_store::{Database, billing::Service};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;

const TOKEN: &str = "disposable-provider-fixture";
const SECRET: &str = "disposable-signed-refund-fixture";
const PATH: &str = "/api/billing/polar/webhook";

struct Provider {
    pool: PgPool,
    workspace: String,
    subscription_id: String,
    refund_event: String,
    starter_product: String,
    plus_product: String,
    subscription: Mutex<Value>,
    paid_upgrade: Value,
    refunded_order: Value,
    paid_starter: Value,
    changed_at: String,
    basis_available: AtomicBool,
    patches: AtomicUsize,
    requests: Mutex<Vec<String>>,
}
impl Provider {
    fn take_requests(&self) -> Vec<String> {
        std::mem::take(&mut *self.requests.lock().unwrap())
    }
}
#[async_trait]
impl Transport for Provider {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        assert_eq!(token, TOKEN);
        let url = Url::parse(&request.url).unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://sandbox-api.polar.sh"
        );
        if request.method == "GET" {
            assert!(request.body.is_none());
            if url.path() == format!("/v1/orders/{}", self.refunded_order["id"].as_str().unwrap()) {
                assert!(url.query().is_none());
                self.requests.lock().unwrap().push("get refund".into());
                return Ok(self.refunded_order.clone());
            }
            if url.path() == format!("/v1/subscriptions/{}", self.subscription_id) {
                assert!(url.query().is_none());
                self.requests
                    .lock()
                    .unwrap()
                    .push("get subscription".into());
                return Ok(self.subscription.lock().unwrap().clone());
            }
            assert_eq!(url.path(), "/v1/orders/");
            let query: Vec<_> = url.query_pairs().into_owned().collect();
            for (key, value) in [
                ("subscription_id", self.subscription_id.clone()),
                (
                    "external_customer_id",
                    format!("forge:workspace:{}", self.workspace),
                ),
                ("page", "1".into()),
                ("limit", "100".into()),
            ] {
                assert!(query.contains(&(key.into(), value)));
            }
            let items = if query.contains(&("product_id".into(), self.plus_product.clone())) {
                self.requests
                    .lock()
                    .unwrap()
                    .push("find paid upgrade".into());
                json!([self.paid_upgrade])
            } else {
                assert!(query.contains(&("product_id".into(), self.starter_product.clone())));
                self.requests
                    .lock()
                    .unwrap()
                    .push("find starter basis".into());
                if self.basis_available.load(Ordering::SeqCst) {
                    json!([self.paid_starter])
                } else {
                    json!([])
                }
            };
            return Ok(json!({"items":items,"pagination":{"max_page":1}}));
        }
        assert_eq!(request.method, "PATCH");
        assert_eq!(
            url.path(),
            format!("/v1/subscriptions/{}", self.subscription_id)
        );
        assert!(url.query().is_none());
        assert_eq!(
            request.body,
            Some(json!({"product_id":self.starter_product,"proration_behavior":"next_period"}))
        );
        self.requests
            .lock()
            .unwrap()
            .push("schedule starter".into());

        // A separate SQL checkout observes the committed restriction before the
        // provider effect. A transaction held across this request cannot pass.
        let restricted = state(&self.pool, &self.workspace).await;
        assert_eq!(restricted["plan"], "basic");
        assert!(restricted["paid_upgrade_order_id"].is_null());
        assert_eq!(
            restricted["refunded_periods"][0]["orderId"],
            self.refunded_order["id"]
        );
        let receipt: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM billing_event_receipts WHERE workspace_id=$1 AND event_id=$2",
        )
        .bind(&self.workspace)
        .bind(&self.refund_event)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        assert_eq!(receipt, 1);
        let mut subscription = self.subscription.lock().unwrap();
        subscription["pending_update"]["product_id"] = json!(self.starter_product);
        subscription["modified_at"] = json!(self.changed_at);
        assert_eq!(
            self.patches.fetch_add(1, Ordering::SeqCst),
            0,
            "retry must observe the accepted effect"
        );
        // Polar accepted the mutation; the response never arrived.
        Err(Error("BILLING_PROVIDER_UNAVAILABLE"))
    }
}
async fn state(pool: &PgPool, workspace: &str) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn receipts(pool: &PgPool, workspace: &str) -> Value {
    sqlx::query_scalar("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY event_id),'[]'::jsonb) FROM billing_event_receipts r WHERE workspace_id=$1")
        .bind(workspace).fetch_one(pool).await.unwrap()
}
async fn audits(pool: &PgPool, workspace: &str) -> Value {
    sqlx::query_scalar("SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM workspace_security_audit_events a WHERE workspace_id=$1 AND action LIKE 'billing.%'")
        .bind(workspace).fetch_one(pool).await.unwrap()
}
fn access(state: &Value) -> Value {
    serde_json::to_value(subscription_access(
        SubscriptionState::from_json(state.clone()).as_ref(),
        Some(Utc::now()),
    ))
    .unwrap()
}
fn signed_request(event: &str, raw: &[u8], valid: bool) -> HttpRequest<Body> {
    let timestamp = Utc::now().timestamp().to_string();
    let mut signature = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    signature.update(format!("{event}.{timestamp}.").as_bytes());
    signature.update(raw);
    let signature = if valid {
        STANDARD.encode(signature.finalize().into_bytes())
    } else {
        STANDARD.encode([0_u8; 32])
    };
    HttpRequest::builder()
        .method("POST")
        .uri(PATH)
        .header("webhook-id", event)
        .header("webhook-timestamp", timestamp)
        .header("webhook-signature", format!("v1,{signature}"))
        .body(Body::from(raw.to_vec()))
        .unwrap()
}
async fn deliver(
    router: &Router,
    event: &str,
    raw: &[u8],
    valid: bool,
    status: StatusCode,
    code: &str,
) {
    let response = router
        .clone()
        .oneshot(signed_request(event, raw, valid))
        .await
        .unwrap();
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"code":code})
    );
}

#[tokio::test]
async fn signed_refund_commits_restriction_before_lost_effect_and_retries_from_fresh_provider_proof()
 {
    let connection = std::env::var("FORGE_RUST_TEST_DATABASE_URL")
        .expect("Run bun run rewrite:verify for disposable PostgreSQL");
    let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert_eq!(options.get_username(), "forge_rust_test");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    let database = Database::new(pool.clone());
    let workspace = Uuid::new_v4().to_string();
    let subscription_id = Uuid::new_v4().to_string();
    let order_id = Uuid::new_v4().to_string();
    let starter_order = Uuid::new_v4().to_string();
    let starter = Uuid::new_v4().to_string();
    let plus = Uuid::new_v4().to_string();
    let event = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Signed refund fixture',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    let now = chrono::DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    let start = stamp(now - Duration::days(10));
    let end = stamp(now + Duration::days(20));
    let paid_at = stamp(now - Duration::days(2));
    let changed_at = stamp(now - Duration::minutes(30));
    let customer = json!({"external_id":format!("forge:workspace:{workspace}")});
    let paid_upgrade = json!({
        "id":order_id,"customer":customer,"subscription_id":subscription_id,"product_id":plus,"currency":"eur",
        "billing_reason":"subscription_update","status":"paid","paid":true,"net_amount":1000,"tax_amount":200,
        "total_amount":1200,"due_amount":1200,"applied_balance_amount":0,"refunded_amount":0,"refunded_tax_amount":0,
        "created_at":paid_at,"modified_at":paid_at,
        "items":[{"amount":1000,"tax_amount":200,"proration":true,"start_timestamp":paid_at,"end_timestamp":end}],
    });
    let mut refunded_order = paid_upgrade.clone();
    refunded_order["status"] = json!("refunded");
    refunded_order["refunded_amount"] = json!(1000);
    refunded_order["refunded_tax_amount"] = json!(200);
    refunded_order["modified_at"] = json!(stamp(now - Duration::hours(1)));
    let mut paid_starter = paid_upgrade.clone();
    paid_starter["id"] = json!(starter_order);
    paid_starter["product_id"] = json!(starter);
    paid_starter["billing_reason"] = json!("subscription_create");
    paid_starter["created_at"] = json!(start);
    paid_starter["modified_at"] = json!(start);
    paid_starter["items"][0]["proration"] = json!(false);
    paid_starter["items"][0]["start_timestamp"] = json!(start);
    let provider = Arc::new(Provider {
        pool: pool.clone(),
        workspace: workspace.clone(),
        subscription_id: subscription_id.clone(),
        refund_event: event.clone(),
        starter_product: starter.clone(),
        plus_product: plus.clone(),
        paid_upgrade,
        refunded_order,
        paid_starter,
        changed_at,
        basis_available: AtomicBool::new(false),
        patches: AtomicUsize::new(0),
        requests: Mutex::new(vec![]),
        subscription: Mutex::new(json!({
            "id":subscription_id,"customer":customer,"product_id":plus,"currency":"eur","amount":4800,"seats":3,
            "status":"active","modified_at":stamp(now-Duration::hours(2)),"created_at":start,
            "current_period_start":start,"current_period_end":end,"recurring_interval":"month","recurring_interval_count":1,
            "past_due_at":null,"cancel_at_period_end":false,"pause_at_period_end":false,"paused_at":null,"resumes_at":null,"ends_at":null,"ended_at":null,
            "pending_update":{"id":Uuid::new_v4(),"product_id":null,"seats":5,"units":null,"applies_at":end},
        })),
    });
    let client = Arc::new(Client {
        config: Enabled {
            enabled: true,
            environment: "sandbox".into(),
            access_token: TOKEN.into(),
            webhook_secret: SECRET.into(),
            app_url: "https://forge.example".into(),
            paid_products: json!({"starter":{"eur":starter,"usd":Uuid::new_v4()},"plus":{"eur":plus,"usd":Uuid::new_v4()}}),
        },
        transport: provider.clone(),
    });
    let service = Service::new(database.clone());
    let reconciler = Reconciler::new(client.clone(), Arc::new(service.clone()));
    assert_eq!(reconciler.reconcile(&json!({"workspaceId":workspace,"subscriptionId":subscription_id,"eventId":Uuid::new_v4(),"bodyHash":"a".repeat(64)})).await.unwrap()["effectivePlan"], "business");
    assert_eq!(
        provider.take_requests(),
        ["get subscription", "find paid upgrade"]
    );
    let initial = state(&pool, &workspace).await;
    assert_eq!(access(&initial)["plan"], "business");
    let initial_receipts = receipts(&pool, &workspace).await;
    let initial_audits = audits(&pool, &workspace).await;

    let handler = Arc::new(Settings::handler(client, service));
    let raw = serde_json::to_vec(&json!({"type":"order.refunded","data":{"id":order_id,"customer":customer,"status":"paid","product_id":"untrusted","refunded_amount":0}})).unwrap();
    assert!(
        Settings::configured(database, &HashMap::new())
            .unwrap()
            .webhook
            .is_none()
    );
    let disabled = router_with_state(AppState::default().with_billing(Settings {
        enabled: false,
        rollouts: FeatureRollouts::parse(None).unwrap(),
        webhook: Some(handler.clone()),
    }));
    assert_eq!(
        disabled
            .oneshot(signed_request(&event, &raw, true))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let router = router_with_state(AppState::default().with_billing(Settings {
        enabled: true,
        rollouts: FeatureRollouts::parse(None).unwrap(),
        webhook: Some(handler),
    }));
    deliver(
        &router,
        &event,
        &raw,
        false,
        StatusCode::BAD_REQUEST,
        "INVALID_WEBHOOK",
    )
    .await;
    assert!(provider.take_requests().is_empty());
    assert_eq!(state(&pool, &workspace).await, initial);
    assert_eq!(receipts(&pool, &workspace).await, initial_receipts);
    assert_eq!(audits(&pool, &workspace).await, initial_audits);

    deliver(
        &router,
        &event,
        &raw,
        true,
        StatusCode::SERVICE_UNAVAILABLE,
        "BILLING_RECONCILIATION_REQUIRED",
    )
    .await;
    assert_eq!(
        provider.take_requests(),
        [
            "get refund",
            "find starter basis",
            "get subscription",
            "schedule starter"
        ]
    );
    let restricted = state(&pool, &workspace).await;
    assert_eq!(access(&restricted)["plan"], "free");
    assert!(restricted["paid_upgrade_order_id"].is_null());
    assert_eq!(restricted["refunded_periods"].as_array().unwrap().len(), 1);
    assert!(restricted["refunded_periods"][0]["starterOrderId"].is_null());
    assert_eq!(
        receipts(&pool, &workspace).await.as_array().unwrap().len(),
        initial_receipts.as_array().unwrap().len() + 1
    );
    assert_eq!(
        audits(&pool, &workspace).await.as_array().unwrap().len(),
        initial_audits.as_array().unwrap().len() + 1
    );
    let body_hash: String = sqlx::query_scalar(
        "SELECT body_hash FROM billing_event_receipts WHERE workspace_id=$1 AND event_id=$2",
    )
    .bind(&workspace)
    .bind(&event)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(body_hash, format!("{:x}", Sha256::digest(&raw)));

    // The fresh GET sees the already scheduled Starter product. Confirmation is
    // durable, but missing paid base evidence still returns a retryable 503.
    deliver(
        &router,
        &event,
        &raw,
        true,
        StatusCode::SERVICE_UNAVAILABLE,
        "BILLING_RECONCILIATION_REQUIRED",
    )
    .await;
    assert_eq!(
        provider.take_requests(),
        ["get refund", "find starter basis", "get subscription"]
    );
    assert_eq!(state(&pool, &workspace).await, restricted);
    assert_eq!(
        receipts(&pool, &workspace).await.as_array().unwrap().len(),
        initial_receipts.as_array().unwrap().len() + 2
    );
    let confirmations: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.upgrade_refund.renewal_confirmed'")
        .bind(&workspace).fetch_one(&pool).await.unwrap();
    assert_eq!(confirmations, 1);

    provider.basis_available.store(true, Ordering::SeqCst);
    deliver(&router, &event, &raw, true, StatusCode::OK, "RECONCILED").await;
    assert_eq!(
        provider.take_requests(),
        ["get refund", "find starter basis", "get subscription"]
    );
    let restored = state(&pool, &workspace).await;
    assert_eq!(access(&restored)["plan"], "basic");
    assert_eq!(restored["refunded_periods"].as_array().unwrap().len(), 1);
    assert_eq!(
        restored["refunded_periods"][0]["starterOrderId"],
        starter_order
    );
    assert!(restored["paid_upgrade_order_id"].is_null());
    assert_eq!(restored["paid_activated_at"], initial["paid_activated_at"]);
    let final_receipts = receipts(&pool, &workspace).await;
    let final_audits = audits(&pool, &workspace).await;
    assert_eq!(
        final_receipts.as_array().unwrap().len(),
        initial_receipts.as_array().unwrap().len() + 2
    );
    assert_eq!(
        final_audits.as_array().unwrap().len(),
        initial_audits.as_array().unwrap().len() + 3
    );
    deliver(&router, &event, &raw, true, StatusCode::OK, "RECONCILED").await;
    assert_eq!(
        provider.take_requests(),
        ["get refund", "find starter basis", "get subscription"]
    );
    assert_eq!(state(&pool, &workspace).await, restored);
    assert_eq!(receipts(&pool, &workspace).await, final_receipts);
    assert_eq!(audits(&pool, &workspace).await, final_audits);
    assert_eq!(provider.patches.load(Ordering::SeqCst), 1);
    let subscription = provider.subscription.lock().unwrap();
    assert_eq!(subscription["seats"], 3);
    assert_eq!(subscription["amount"], 4800);
    assert_eq!(subscription["current_period_start"], start);
    assert_eq!(subscription["current_period_end"], end);
    assert_eq!(subscription["pending_update"]["product_id"], starter);
    assert_eq!(subscription["pending_update"]["seats"], 5);
}
