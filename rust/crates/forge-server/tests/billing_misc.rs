use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::DateTime;
use forge_core::{actor::Actor, billing::configuration::Enabled};
use forge_server::billing_provider::{
    Client, Clock, Error, Request, Transport, coerce_date,
    ecb::{self, Feed, FeedResponse},
    refund_renewal::RenewalSink,
    refunds::{RefundSink, Refunds},
    replacement::{Context, Verifier},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../forge-core/data/billing-misc-reference.json"
    ))
    .unwrap()
}
fn injected_error(value: &Value) -> Result<(), Error> {
    match value.as_str() {
        None => Ok(()),
        Some("BILLING_PROVIDER_UNAVAILABLE") => Err(Error("BILLING_PROVIDER_UNAVAILABLE")),
        Some("BILLING_PERSISTENCE_UNAVAILABLE") => Err(Error("BILLING_PERSISTENCE_UNAVAILABLE")),
        Some("BILLING_REFUND_RENEWAL_NOT_CONFIRMED") => {
            Err(Error("BILLING_REFUND_RENEWAL_NOT_CONFIRMED"))
        }
        Some("BILLING_FX_SOURCE_UNAVAILABLE") => Err(Error("BILLING_FX_SOURCE_UNAVAILABLE")),
        Some("BILLING_ACTOR_REVOKED") => Err(Error("BILLING_ACTOR_REVOKED")),
        Some(other) => panic!("unrecognized source injection: {other}"),
    }
}
fn bytes(value: &Value) -> Option<Vec<u8>> {
    if value.is_null() {
        return None;
    }
    if let Some(encoded) = value["base64"].as_str() {
        return Some(STANDARD.decode(encoded).unwrap());
    }
    let mut result = value["prefix"]
        .as_str()
        .unwrap_or_default()
        .as_bytes()
        .to_vec();
    result.extend(std::iter::repeat_n(
        value["byte"].as_u64().unwrap_or(32) as u8,
        value["count"].as_u64().unwrap_or(0) as usize,
    ));
    result.extend_from_slice(value["suffix"].as_str().unwrap_or_default().as_bytes());
    Some(result)
}
struct Probe {
    input: Value,
    trace: Mutex<Vec<Value>>,
    context_index: Mutex<usize>,
}
impl Probe {
    fn record(&self, value: Value) {
        self.trace.lock().unwrap().push(value);
    }
}
#[async_trait]
impl Transport for Probe {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        assert_eq!(token, "fixture-token");
        assert_eq!(
            request.method, "GET",
            "proof/plan must never mutate provider state"
        );
        assert!(request.body.is_none());
        let url = url::Url::parse(&request.url).unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://sandbox-api.polar.sh"
        );
        if url.path() == "/v1/orders/" {
            let mut query = json!({});
            for (key, value) in url.query_pairs() {
                match key.as_ref() {
                    "status" | "sorting" => {
                        if query.get(key.as_ref()).is_none() {
                            query[key.as_ref()] = json!([]);
                        }
                        query[key.as_ref()]
                            .as_array_mut()
                            .unwrap()
                            .push(json!(value));
                    }
                    "limit" | "page" => query[key.as_ref()] = json!(value.parse::<u32>().unwrap()),
                    _ => query[key.as_ref()] = json!(value),
                }
            }
            self.record(json!({"kind":"orders","query":query}));
            let index = query["page"].as_u64().unwrap() as usize - 1;
            let response = self.input["pages"]
                .get(index)
                .expect("unplanned provider page");
            injected_error(&response["error"])?;
            return Ok(response["value"].clone());
        }
        assert!(url.query().is_none());
        let (kind, id) = if let Some(id) = url.path().strip_prefix("/v1/orders/") {
            ("order", id)
        } else if let Some(id) = url.path().strip_prefix("/v1/subscriptions/") {
            ("subscription", id)
        } else if let Some(id) = url.path().strip_prefix("/v1/checkouts/") {
            ("checkout", id)
        } else {
            panic!("unexpected provider endpoint: {url}")
        };
        self.record(json!({"kind":kind,"id":id}));
        if self.input["kind"] == "refund" {
            injected_error(&self.input["getError"])?;
        } else {
            injected_error(&self.input["errors"][kind])?;
        }
        Ok(self.input[kind].clone())
    }
}
#[async_trait]
impl RefundSink for Probe {
    async fn apply(&self, event: Value) -> Result<Value, Error> {
        self.record(json!({"kind":"apply","event":event}));
        injected_error(&self.input["applyError"])?;
        Ok(self.input["result"].clone())
    }
}
#[async_trait]
impl RenewalSink for Probe {
    async fn reconcile(&self, identity: &Value) -> Result<Value, Error> {
        self.record(json!({"kind":"renew","identity":identity}));
        injected_error(&self.input["renewError"])?;
        Ok(json!({"status":"scheduled","replayed":false}))
    }
}
#[async_trait]
impl Context for Probe {
    async fn resolve(&self, actor: &Actor, request: &str) -> Result<Value, Error> {
        self.record(json!({"kind":"context","actor":actor,"id":request}));
        let mut index = self.context_index.lock().unwrap();
        let step = self.input["contexts"]
            .get(*index)
            .expect("unplanned context resolution");
        *index += 1;
        injected_error(&step["error"])?;
        Ok(step["value"].clone())
    }
}
#[async_trait]
impl Feed for Probe {
    async fn read(&self) -> Result<FeedResponse, Error> {
        self.record(json!({"kind":"feed"}));
        let response = &self.input["response"];
        injected_error(&response["error"])?;
        Ok(FeedResponse {
            status: response["status"].as_u64().unwrap() as u16,
            body: bytes(&response["body"]),
        })
    }
}
fn client(config: &Value, transport: Arc<dyn Transport>) -> Arc<Client> {
    Arc::new(Client {
        config: Enabled {
            enabled: true,
            environment: config["environment"].as_str().unwrap().into(),
            access_token: config["accessToken"].as_str().unwrap().into(),
            webhook_secret: config["webhookSecret"].as_str().unwrap().into(),
            paid_products: config["paidProducts"].clone(),
            app_url: config["appUrl"].as_str().unwrap().into(),
        },
        transport,
    })
}
async fn check(kind: &str) {
    let fixture = fixture();
    let mut failures = vec![];
    let mut count = 0;
    for case in fixture["cases"].as_array().unwrap() {
        if case["kind"] != kind {
            continue;
        }
        count += 1;
        let probe = Arc::new(Probe {
            input: case.clone(),
            trace: Mutex::new(vec![]),
            context_index: Mutex::new(0),
        });
        let now = DateTime::parse_from_rfc3339(
            case["now"].as_str().unwrap_or("2027-01-15T12:00:00.000Z"),
        )
        .unwrap()
        .to_utc();
        let clock_probe = probe.clone();
        let clock: Clock = Arc::new(move || {
            clock_probe.record(json!({"kind":"clock"}));
            now
        });
        let result = match kind {
            "ecb" => ecb::fetch(probe.as_ref(), &clock).await,
            "refund" => {
                Refunds {
                    client: client(&fixture["config"], probe.clone()),
                    sink: probe.clone(),
                    renewal: if case["renew"] == true {
                        Some(probe.clone() as Arc<dyn RenewalSink>)
                    } else {
                        None
                    },
                    basis_lookup: case["basisLookup"] == true,
                }
                .reconcile(&case["input"])
                .await
            }
            "replacement" => {
                Verifier {
                    client: client(&fixture["config"], probe.clone()),
                    context: probe.clone(),
                    clock,
                }
                .plan(
                    &serde_json::from_value(case["actor"].clone()).unwrap(),
                    case["requestId"].as_str().unwrap(),
                    case["orderId"].as_str().unwrap(),
                )
                .await
            }
            _ => panic!("unknown provider fixture kind"),
        };
        let matches = match &result {
            Ok(value) => case["valid"] == true && *value == case["output"],
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
    assert!(count >= 30);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[tokio::test]
async fn ecb_reference_matches_source_feed_validation_freshness_and_clock_order() {
    check("ecb").await;
}
#[tokio::test]
async fn refund_reconciliation_preserves_source_restrictive_commit_before_renewal_and_retry_failure()
 {
    check("refund").await;
}
#[tokio::test]
async fn replacement_payment_proof_remains_read_only_and_matches_source_context_rechecks() {
    check("replacement").await;
}
#[test]
fn pending_provider_date_coercion_matches_v8_in_utc() {
    let fixture = fixture();
    let mut failures = vec![];
    let mut count = 0;
    for case in fixture["cases"].as_array().unwrap() {
        if case["kind"] != "date" {
            continue;
        }
        count += 1;
        let value = if case["input"]["missing"] == true {
            None
        } else {
            case["input"].get("value")
        };
        let date = coerce_date(value);
        let actual = date.map(|date| date.timestamp_millis());
        let iso = date.map(|date| date.to_iso_string());
        if json!(actual) != case["timestampMillis"] || json!(iso) != case["output"] {
            failures.push(format!(
                "{} input={} timestamp={actual:?} iso={iso:?}; expected {} ({})",
                case["name"], case["input"], case["timestampMillis"], case["output"]
            ));
        }
    }
    assert_eq!(count, 72);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
