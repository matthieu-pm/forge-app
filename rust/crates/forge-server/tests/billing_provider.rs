use async_trait::async_trait;
use forge_core::billing::configuration::Enabled;
use forge_server::billing_provider::{
    Client, Error, Request, Transport,
    reconciliation::{Reconciler, SnapshotSink},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use url::Url;

struct Probe {
    case: Value,
    trace: Mutex<Vec<Value>>,
    applied: Mutex<Vec<Value>>,
    page: Mutex<usize>,
}
#[async_trait]
impl Transport for Probe {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        assert_eq!(token, "fixture-token");
        assert_eq!(request.method, "GET");
        assert!(request.body.is_none());
        let url = Url::parse(&request.url).unwrap();
        assert_eq!(url.host_str(), Some("sandbox-api.polar.sh"));
        let kind = if url.path() == "/v1/orders/" {
            "orders"
        } else if url.path().starts_with("/v1/orders/") {
            "order"
        } else {
            "subscription"
        };
        if kind == "orders" {
            let mut query = serde_json::Map::new();
            for (key, value) in url.query_pairs() {
                if ["status", "sorting"].contains(&key.as_ref()) {
                    query
                        .entry(key.into_owned())
                        .or_insert(json!([]))
                        .as_array_mut()
                        .unwrap()
                        .push(json!(value));
                } else if ["limit", "page"].contains(&key.as_ref()) {
                    query.insert(key.into_owned(), json!(value.parse::<u32>().unwrap()));
                } else {
                    query.insert(key.into_owned(), json!(value));
                }
            }
            self.trace
                .lock()
                .unwrap()
                .push(json!({"kind":kind,"query":query}));
        } else {
            self.trace
                .lock()
                .unwrap()
                .push(json!({"kind":kind,"id":url.path().rsplit('/').next().unwrap()}));
        }
        if self.case["fail"] == kind {
            return Err(Error("BILLING_PROVIDER_UNAVAILABLE"));
        }
        if kind == "orders" {
            let pages = self.case["pages"].as_array().unwrap();
            let mut index = self.page.lock().unwrap();
            let value = pages[(*index).min(pages.len() - 1)].clone();
            *index += 1;
            Ok(value)
        } else {
            Ok(self.case[kind].clone())
        }
    }
}
#[async_trait]
impl SnapshotSink for Probe {
    async fn apply(&self, event: Value) -> Result<Value, Error> {
        self.applied.lock().unwrap().push(event);
        if self.case["applyError"] == true {
            return Err(Error("BILLING_PERSISTENCE_UNAVAILABLE"));
        }
        Ok(json!({"changed":true}))
    }
}
fn configuration(value: &Value) -> Enabled {
    Enabled {
        enabled: true,
        environment: value["environment"].as_str().unwrap().into(),
        access_token: value["accessToken"].as_str().unwrap().into(),
        webhook_secret: value["webhookSecret"].as_str().unwrap().into(),
        app_url: value["appUrl"].as_str().unwrap().into(),
        paid_products: value["paidProducts"].clone(),
    }
}
#[tokio::test]
async fn native_subscription_and_order_reconciliation_match_owning_provider_sequences() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../forge-core/data/billing-provider-reference.json"
    ))
    .unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let probe = Arc::new(Probe {
            case: case.clone(),
            trace: Mutex::new(vec![]),
            applied: Mutex::new(vec![]),
            page: Mutex::new(0),
        });
        let client = Arc::new(Client {
            config: configuration(&fixtures["config"]),
            transport: probe.clone(),
        });
        let reconciler = Reconciler {
            client: client.clone(),
            sink: probe.clone(),
            order_proofs: case["hasOrders"].as_bool().unwrap(),
        };
        let result = match case["kind"].as_str().unwrap() {
            "order" => reconciler.reconcile_order(&case["input"]).await,
            "starter" => client.find_starter_basis(&case["input"]).await,
            _ => reconciler.reconcile(&case["input"]).await,
        };
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        match result {
            Ok(value) => assert_eq!(value, case["output"], "{}", case["name"]),
            Err(error) => assert_eq!(error.0, case["error"].as_str().unwrap(), "{}", case["name"]),
        }
        assert_eq!(
            json!(*probe.trace.lock().unwrap()),
            case["requests"],
            "{}",
            case["name"]
        );
        assert_eq!(
            json!(*probe.applied.lock().unwrap()),
            case["applied"],
            "{}",
            case["name"]
        );
    }
}
