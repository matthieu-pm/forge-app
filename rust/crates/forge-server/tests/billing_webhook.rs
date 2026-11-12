use async_trait::async_trait;
use axum::{
    body::{Body, Bytes, to_bytes},
    http::Request,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use forge_core::billing::configuration::Enabled;
use forge_server::billing_provider::{
    Client, Error, Request as ProviderRequest, Transport,
    webhook::{Events, Handler},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
struct NoProvider;
#[async_trait]
impl Transport for NoProvider {
    async fn execute(&self, _: ProviderRequest, _: &str) -> Result<Value, Error> {
        panic!("Webhook verification cannot call a provider directly")
    }
}
struct Probe {
    trace: Mutex<Vec<Value>>,
    no_order: bool,
    failure: bool,
}
impl Probe {
    fn call(&self, kind: &str, identity: &Value) -> Result<Value, Error> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":kind,"identity":identity}));
        if self.failure {
            Err(Error("private provider token and SQL diagnostics"))
        } else {
            Ok(json!({"outcome":"applied","replayed":false}))
        }
    }
}
#[async_trait]
impl Events for Probe {
    async fn subscription(&self, identity: &Value) -> Result<Value, Error> {
        self.call("subscription", identity)
    }
    async fn order(&self, identity: &Value) -> Result<Value, Error> {
        if self.no_order {
            return Err(Error("BILLING_ORDER_RECONCILIATION_REQUIRED"));
        }
        self.call("order", identity)
    }
    async fn refund(&self, identity: &Value) -> Result<Value, Error> {
        self.call("refund", identity)
    }
}
fn client(config: &Value, case: &Value) -> Arc<Client> {
    Arc::new(Client {
        config: Enabled {
            enabled: case["enabled"].as_bool().unwrap_or(true),
            environment: config["environment"].as_str().unwrap().into(),
            access_token: config["accessToken"].as_str().unwrap().into(),
            webhook_secret: case["secret"].as_str().unwrap_or("fixture-secret").into(),
            paid_products: config["paidProducts"].clone(),
            app_url: config["appUrl"].as_str().unwrap().into(),
        },
        transport: Arc::new(NoProvider),
    })
}
fn bytes(value: &Value) -> Vec<u8> {
    if let Some(encoded) = value["base64"].as_str() {
        return STANDARD.decode(encoded).unwrap();
    }
    let mut out = value["prefix"]
        .as_str()
        .unwrap_or_default()
        .as_bytes()
        .to_vec();
    out.extend(std::iter::repeat_n(
        value["byte"].as_u64().unwrap_or(32) as u8,
        value["count"].as_u64().unwrap_or(0) as usize,
    ));
    out.extend_from_slice(value["suffix"].as_str().unwrap_or_default().as_bytes());
    out
}
#[tokio::test]
async fn webhook_matches_owning_handler_and_pinned_sdk_signature_and_dispatch_cases() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../forge-core/data/billing-webhook-reference.json"
    ))
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = vec![];
    for case in cases {
        let probe = Arc::new(Probe {
            trace: Mutex::new(vec![]),
            no_order: case["noOrder"] == true,
            failure: case["callbackFailure"] == true,
        });
        let now = DateTime::parse_from_rfc3339(case["now"].as_str().unwrap())
            .unwrap()
            .to_utc();
        let handler = Handler {
            client: Some(client(&fixture["config"], case)),
            events: probe.clone(),
            now: Arc::new(move || now),
        };
        let mut request = Request::builder()
            .method(case["method"].as_str().unwrap())
            .uri("https://forge.example.test/api/billing/polar/webhook");
        for pair in case["headers"].as_array().unwrap() {
            request = request.header(pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        }
        let chunks: Vec<_> = bytes(&case["body"])
            .chunks(16384)
            .map(Bytes::copy_from_slice)
            .map(Ok::<_, Infallible>)
            .collect();
        let response = handler
            .handle(
                request
                    .body(Body::from_stream(futures_util::stream::iter(chunks)))
                    .unwrap(),
            )
            .await;
        let status = response.status().as_u16();
        let cache = response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        let actual = json!({"status":status,"cacheControl":cache,"body":body});
        if actual != case["result"] {
            failures.push(format!(
                "{}: response {actual}, expected {}",
                case["name"], case["result"]
            ));
        }
        let trace = json!(*probe.trace.lock().unwrap());
        if trace != case["trace"] {
            failures.push(format!(
                "{}: trace {trace}, expected {}",
                case["name"], case["trace"]
            ));
        }
    }
    assert!(cases.len() >= 150);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[tokio::test]
async fn webhook_stops_reading_when_limit_exceeded_and_keeps_disabled_handlers_inert() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../forge-core/data/billing-webhook-reference.json"
    ))
    .unwrap();
    let probe = Arc::new(Probe {
        trace: Mutex::new(vec![]),
        no_order: false,
        failure: false,
    });
    let polls = Arc::new(AtomicUsize::new(0));
    let count = polls.clone();
    let body = Body::from_stream(futures_util::stream::poll_fn(move |_| {
        let index = count.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Ok::<_, Infallible>(Bytes::from(vec![
            b'x';
            if index == 0 {
                1_048_576
            } else {
                1
            }
        ]))))
    }));
    let handler = Handler {
        client: Some(client(&fixture["config"], &json!({"enabled":true}))),
        events: probe.clone(),
        now: Arc::new(Utc::now),
    };
    let response = handler.handle(Request::post("/").body(body).unwrap()).await;
    assert_eq!(response.status(), 413);
    assert_eq!(polls.load(Ordering::SeqCst), 2);
    assert!(probe.trace.lock().unwrap().is_empty());
    let polls = Arc::new(AtomicUsize::new(0));
    let count = polls.clone();
    let body = Body::from_stream(futures_util::stream::poll_fn(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(None::<Result<Bytes, Infallible>>)
    }));
    let handler = Handler {
        client: None,
        events: probe.clone(),
        now: Arc::new(|| panic!("disabled handler must not read clock")),
    };
    assert_eq!(
        handler
            .handle(Request::post("/").body(body).unwrap())
            .await
            .status(),
        404
    );
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    assert!(probe.trace.lock().unwrap().is_empty());
}
