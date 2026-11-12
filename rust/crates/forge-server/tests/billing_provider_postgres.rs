use async_trait::async_trait;
use chrono::{Duration, Utc};
use forge_core::billing::{
    calendar::{date, stamp},
    configuration::Enabled,
};
use forge_server::billing_provider::{
    Client, Error, Request, Transport, reconciliation::Reconciler,
};
use forge_store::{Database, billing::Service};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use url::Url;
use uuid::Uuid;

/// Every response is consumed by an actual adapter request. No transport or
/// caller-provided snapshot bypasses the provider validators and durable sink.
struct Provider {
    responses: Mutex<VecDeque<(String, Value)>>,
    requests: Mutex<Vec<String>>,
    workspace: String,
    subscription: String,
}
impl Provider {
    fn push(&self, path: &str, response: Value) {
        self.responses
            .lock()
            .unwrap()
            .push_back((path.into(), response));
    }
    fn subscription(&self, response: &Value) {
        self.push(
            &format!("/v1/subscriptions/{}", self.subscription),
            response.clone(),
        );
    }
    fn page(&self, items: Value, max_page: u32) {
        self.push(
            "/v1/orders/",
            json!({"items":items,"pagination":{"max_page":max_page}}),
        );
    }
}
#[async_trait]
impl Transport for Provider {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        assert_eq!(token, "disposable-provider-fixture");
        assert_eq!(request.method, "GET");
        assert!(request.body.is_none());
        let url = Url::parse(&request.url).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("sandbox-api.polar.sh"));
        let (path, response) = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected provider request");
        assert_eq!(url.path(), path);
        if path == "/v1/orders/" {
            let query: Vec<_> = url.query_pairs().into_owned().collect();
            assert!(query.contains(&("subscription_id".into(), self.subscription.clone())));
            assert!(query.contains(&(
                "external_customer_id".into(),
                format!("forge:workspace:{}", self.workspace)
            )));
            assert!(query.contains(&("limit".into(), "100".into())));
        }
        self.requests.lock().unwrap().push(request.url);
        Ok(response)
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
fn event(workspace: &str, subscription: &str, digest: char) -> Value {
    json!({"workspaceId":workspace,"subscriptionId":subscription,"eventId":Uuid::new_v4().to_string(),"bodyHash":digest.to_string().repeat(64)})
}

#[tokio::test]
async fn fresh_provider_evidence_reaches_durable_receipts_without_trusting_input_claims() {
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
    let workspace = Uuid::new_v4().to_string();
    let subscription_id = Uuid::new_v4().to_string();
    let starter = Uuid::new_v4().to_string();
    let plus = Uuid::new_v4().to_string();
    let order_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Provider boundary fixture',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    let provider = Arc::new(Provider {
        responses: Mutex::new(VecDeque::new()),
        requests: Mutex::new(Vec::new()),
        workspace: workspace.clone(),
        subscription: subscription_id.clone(),
    });
    let reconciler = Reconciler::new(
        Arc::new(Client {
            config: Enabled {
                enabled: true,
                environment: "sandbox".into(),
                access_token: "disposable-provider-fixture".into(),
                webhook_secret: "disposable-webhook-fixture".into(),
                app_url: "https://forge.example".into(),
                paid_products: json!({"starter":{"eur":starter,"usd":starter},"plus":{"eur":plus,"usd":plus}}),
            },
            transport: provider.clone(),
        }),
        Arc::new(Service::new(Database::new(pool.clone()))),
    );
    let now = chrono::DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    let start = stamp(now - Duration::days(10));
    let end = stamp(now + Duration::days(20));
    let mut subscription = json!({
        "id":subscription_id,"customer":{"external_id":format!("forge:workspace:{workspace}")},
        "product_id":starter,"currency":"eur","status":"active","modified_at":stamp(now-Duration::days(9)),
        "created_at":start,"current_period_start":start,"current_period_end":end,
        "recurring_interval":"month","recurring_interval_count":1,"past_due_at":null,
        "cancel_at_period_end":false,"ends_at":null,"ended_at":null,
        "pause_at_period_end":false,"paused_at":null,"resumes_at":null,
    });
    let mut initial = event(&workspace, &subscription_id, 'a');
    initial["snapshot"] =
        json!({"plan":"plus","status":"active","paidUpgrade":{"orderId":order_id}});
    provider.subscription(&subscription);
    let result = reconciler.reconcile(&initial).await.unwrap();
    assert_eq!(result["effectivePlan"], "basic");
    assert_eq!(result["replayed"], false);
    let activated = state(&pool, &workspace).await;
    assert_eq!(activated["source"], "polar");
    assert_eq!(activated["source_reference"], subscription_id);
    assert_eq!(activated["plan"], "basic");
    assert!(!activated["paid_activated_at"].is_null());
    assert!(activated["paid_upgrade_order_id"].is_null());
    let initial_receipts = receipts(&pool, &workspace).await;
    assert_eq!(initial_receipts.as_array().unwrap().len(), 1);
    assert_eq!(initial_receipts[0]["body_hash"], initial["bodyHash"]);
    provider.subscription(&subscription);
    assert_eq!(
        reconciler.reconcile(&initial).await.unwrap()["replayed"],
        true
    );
    assert_eq!(state(&pool, &workspace).await, activated);
    assert_eq!(receipts(&pool, &workspace).await, initial_receipts);

    let mut conflicting = initial.clone();
    conflicting["bodyHash"] = json!("f".repeat(64));
    provider.subscription(&subscription);
    assert_eq!(
        reconciler.reconcile(&conflicting).await.unwrap_err().0,
        "BILLING_EVENT_CONFLICT"
    );
    let mut foreign = subscription.clone();
    foreign["customer"]["external_id"] = json!("forge:workspace:another-workspace");
    provider.subscription(&foreign);
    assert_eq!(
        reconciler
            .reconcile(&event(&workspace, &subscription_id, 'b'))
            .await
            .unwrap_err()
            .0,
        "BILLING_PROVIDER_IDENTITY_MISMATCH"
    );
    assert_eq!(state(&pool, &workspace).await, activated);
    assert_eq!(receipts(&pool, &workspace).await, initial_receipts);

    subscription["product_id"] = json!(plus);
    subscription["modified_at"] = json!(stamp(now - Duration::days(1)));
    let mut upgrade = event(&workspace, &subscription_id, 'c');
    upgrade["paidUpgrade"] = json!({"orderId":order_id,"subscriptionId":subscription_id,"periodStart":start,"periodEnd":end});
    provider.subscription(&subscription);
    provider.page(json!([]), 1);
    assert_eq!(
        reconciler.reconcile(&upgrade).await.unwrap()["effectivePlan"],
        "basic"
    );
    assert!(state(&pool, &workspace).await["paid_upgrade_order_id"].is_null());
    let pending_receipts = receipts(&pool, &workspace).await;
    assert_eq!(pending_receipts.as_array().unwrap().len(), 2);

    let paid_at = stamp(now - Duration::days(2));
    let paid = json!({
        "id":order_id,"customer":{"external_id":format!("forge:workspace:{workspace}")},
        "subscription_id":subscription_id,"product_id":plus,"currency":"eur",
        "billing_reason":"subscription_update","status":"paid","paid":true,
        "net_amount":1000,"tax_amount":200,"total_amount":1200,"due_amount":1200,
        "applied_balance_amount":0,"refunded_amount":0,"refunded_tax_amount":0,"created_at":paid_at,
        "items":[{"amount":1000,"proration":true,"start_timestamp":paid_at,"end_timestamp":end}],
    });
    provider.subscription(&subscription);
    provider.page(json!([]), 2);
    provider.page(json!([paid]), 2);
    let result = reconciler.reconcile(&upgrade).await.unwrap();
    assert_eq!(result["effectivePlan"], "business");
    assert_eq!(result["replayed"], true);
    let upgraded = state(&pool, &workspace).await;
    assert_eq!(upgraded["plan"], "business");
    assert_eq!(upgraded["paid_upgrade_order_id"], order_id);
    assert_eq!(
        upgraded["paid_activated_at"],
        activated["paid_activated_at"]
    );
    assert_eq!(receipts(&pool, &workspace).await, pending_receipts);
    assert!(provider.requests.lock().unwrap().iter().any(|request| {
        Url::parse(request)
            .unwrap()
            .query_pairs()
            .any(|(key, value)| key == "page" && value == "2")
    }));

    let paused_at = stamp(now - Duration::hours(1));
    subscription["status"] = json!("paused");
    subscription["paused_at"] = json!(paused_at);
    subscription["modified_at"] = json!(paused_at);
    provider.subscription(&subscription);
    assert_eq!(
        reconciler
            .reconcile(&event(&workspace, &subscription_id, 'd'))
            .await
            .unwrap()["effectivePlan"],
        "free"
    );
    let paused = state(&pool, &workspace).await;
    assert_eq!(
        date(&paused["unsupported_pause_at"]).unwrap(),
        date(&json!(paused_at)).unwrap()
    );
    subscription["status"] = json!("active");
    subscription["paused_at"] = Value::Null;
    subscription["modified_at"] = json!(stamp(now - Duration::minutes(30)));
    let mut resume = event(&workspace, &subscription_id, 'e');
    resume["unsupportedResume"] = json!(true);
    provider.subscription(&subscription);
    assert_eq!(
        reconciler.reconcile(&resume).await.unwrap()["effectivePlan"],
        "free"
    );
    assert_eq!(
        state(&pool, &workspace).await["unsupported_pause_at"],
        paused["unsupported_pause_at"]
    );
    assert_eq!(
        receipts(&pool, &workspace).await.as_array().unwrap().len(),
        4
    );
    assert!(provider.responses.lock().unwrap().is_empty());
}
