use async_trait::async_trait;
use forge_core::{actor::Actor, billing::configuration::Enabled};
use forge_server::billing_provider::{
    Client, Error, Request, Transport,
    checkout::{Checkout, Context},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

struct Probe {
    trace: Mutex<Vec<Value>>,
    contexts: Mutex<VecDeque<Value>>,
    responses: Mutex<VecDeque<Value>>,
}
fn fixture_result(step: Value) -> Result<Value, Error> {
    match step["error"].as_str() {
        Some("BILLING_ACTOR_REVOKED") => Err(Error("BILLING_ACTOR_REVOKED")),
        Some("BILLING_PROVIDER_UNAVAILABLE") => Err(Error("BILLING_PROVIDER_UNAVAILABLE")),
        Some(other) => panic!("unknown source fixture failure: {other}"),
        None => Ok(step["value"].clone()),
    }
}
#[async_trait]
impl Context for Probe {
    async fn resolve(&self, actor: &Actor) -> Result<Value, Error> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind": "context", "actor": actor}));
        let step = self
            .contexts
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected authority resolution");
        fixture_result(step)
    }
}
#[async_trait]
impl Transport for Probe {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        assert_eq!(token, "fixture-token");
        let url = url::Url::parse(&request.url).unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://sandbox-api.polar.sh"
        );
        assert!(url.query().is_none());
        let kind;
        let trace;
        if let Some(id) = url.path().strip_prefix("/v1/products/") {
            assert_eq!(request.method, "GET");
            assert!(request.body.is_none());
            kind = "product";
            trace = json!({"kind": kind, "id": id});
        } else {
            assert_eq!(request.method, "POST");
            kind = match url.path() {
                "/v1/checkouts/" => "checkout",
                "/v1/customer-sessions/" => "portal",
                other => panic!("unexpected provider path: {other}"),
            };
            trace = json!({"kind": kind, "body": request.body.expect("session body")});
        }
        self.trace.lock().unwrap().push(trace);
        let step = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected provider request");
        assert_eq!(step["kind"], kind);
        fixture_result(step)
    }
}
fn config(input: &Value) -> Enabled {
    Enabled {
        enabled: true,
        environment: input["environment"].as_str().unwrap().into(),
        access_token: input["accessToken"].as_str().unwrap().into(),
        webhook_secret: input["webhookSecret"].as_str().unwrap().into(),
        paid_products: input["paidProducts"].clone(),
        app_url: input["appUrl"].as_str().unwrap().into(),
    }
}
async fn check(kind: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../forge-core/data/billing-checkout-reference.json"
    ))
    .unwrap();
    let mut count = 0;
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        if case["kind"] != kind {
            continue;
        }
        count += 1;
        let probe = Arc::new(Probe {
            trace: Mutex::new(vec![]),
            contexts: Mutex::new(case["contexts"].as_array().unwrap().clone().into()),
            responses: Mutex::new(case["responses"].as_array().unwrap().clone().into()),
        });
        let adapter = Checkout {
            client: Arc::new(Client {
                config: config(&fixture["config"]),
                transport: probe.clone(),
            }),
            context: probe.clone(),
        };
        let actor = serde_json::from_value(case["actor"].clone()).unwrap();
        let result = if kind == "checkout" {
            adapter
                .create_checkout(&actor, case["plan"].as_str().unwrap())
                .await
        } else {
            adapter.create_portal(&actor).await
        };
        let matches = match &result {
            Ok(output) => case["valid"] == true && *output == case["output"],
            Err(error) => case["valid"] == false && case["error"] == error.0,
        };
        if !matches {
            failures.push(format!(
                "{}: actual {result:?}; expected valid={} output={} error={}",
                case["name"], case["valid"], case["output"], case["error"]
            ));
        }
        let trace = json!(*probe.trace.lock().unwrap());
        if trace != case["trace"] {
            failures.push(format!(
                "{}: trace {trace}; expected {}",
                case["name"], case["trace"]
            ));
        }
    }
    assert!(count > 25);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[tokio::test]
async fn checkout_matches_source_authority_catalog_payload_and_pending_redirect_contracts() {
    check("checkout").await;
}
#[tokio::test]
async fn portal_matches_source_authority_before_and_after_provider_io() {
    check("portal").await;
}
