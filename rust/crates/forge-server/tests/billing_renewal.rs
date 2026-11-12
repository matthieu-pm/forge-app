use async_trait::async_trait;
use chrono::{DateTime, Utc};
use forge_core::{actor::Actor, billing::configuration::Enabled};
use forge_server::billing_provider::{
    Client, Error, ManagementContext, Request, Transport,
    cancellation::Cancellation,
    currency::{CurrencyPlanner, CurrencyRequestSink},
    reconciliation::SnapshotSink,
    refund_renewal::{RefundRenewal, RefundRenewalStore},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

struct Probe {
    case: Value,
    current: Mutex<Value>,
    indexes: Mutex<HashMap<String, usize>>,
    trace: Mutex<Vec<Value>>,
}
impl Probe {
    fn trace(&self, value: Value) {
        self.trace.lock().unwrap().push(value);
    }
    fn step(&self, name: &str) -> Value {
        let entries = self.case[name].as_array().unwrap();
        let mut indexes = self.indexes.lock().unwrap();
        let index = indexes.entry(name.into()).or_default();
        let step = if entries.is_empty() {
            json!({})
        } else {
            entries[(*index).min(entries.len() - 1)].clone()
        };
        *index += 1;
        step
    }
    fn result(step: &Value, fallback: Value) -> Result<Value, Error> {
        if let Some(error) = step["error"].as_str() {
            return Err(Error(match error {
                "BILLING_PROVIDER_UNAVAILABLE" => "BILLING_PROVIDER_UNAVAILABLE",
                "BILLING_PERSISTENCE_UNAVAILABLE" => "BILLING_PERSISTENCE_UNAVAILABLE",
                "BILLING_ACTOR_REVOKED" => "BILLING_ACTOR_REVOKED",
                _ => panic!("unknown fixture error {error}"),
            }));
        }
        Ok(step.get("value").cloned().unwrap_or(fallback))
    }
    fn patch(current: &mut Value, step: &Value) {
        if let Some(patch) = step["patch"].as_object() {
            current.as_object_mut().unwrap().extend(patch.clone());
        }
        if let Some(remove) = step["remove"].as_array() {
            for key in remove {
                current
                    .as_object_mut()
                    .unwrap()
                    .remove(key.as_str().unwrap());
            }
        }
    }
    fn clock(&self) -> DateTime<Utc> {
        let values = self.case["clocks"].as_array().unwrap();
        let mut indexes = self.indexes.lock().unwrap();
        let index = indexes.entry("clock".into()).or_default();
        let value = &values[(*index).min(values.len() - 1)];
        *index += 1;
        self.trace(json!({"kind":"clock","value":value}));
        DateTime::parse_from_rfc3339(value.as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc)
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
        let id = url.path().strip_prefix("/v1/subscriptions/").unwrap();
        if request.method == "GET" {
            assert!(request.body.is_none());
            self.trace(json!({"kind":"get","id":id}));
            let step = self.step("gets");
            let mut current = self.current.lock().unwrap();
            Self::patch(&mut current, &step);
            Self::result(&step, current.clone())
        } else {
            assert_eq!(request.method, "PATCH");
            let body = request.body.unwrap();
            self.trace(json!({"kind":"update","id":id,"body":body}));
            let step = self.step("updates");
            let mut current = self.current.lock().unwrap();
            if step["auto"] != false {
                if body["cancel_at_period_end"] == true {
                    current["cancel_at_period_end"] = json!(true);
                    current["ends_at"] = current["current_period_end"].clone();
                    current["modified_at"] = json!("2027-01-15T12:00:00.000Z");
                }
                if let Some(product) = body.get("product_id") {
                    let base = if current["pending_update"].is_null() {
                        json!({"id":"00000000-0000-4000-8000-000000000098","created_at":"2027-01-01T00:00:00.000Z","modified_at":"2027-01-01T00:00:00.000Z","applies_at":"2027-02-01T00:00:00.000Z","product_id":null,"seats":null,"units":null})
                    } else {
                        current["pending_update"].clone()
                    };
                    let mut pending = base.as_object().cloned().unwrap_or_default();
                    pending.insert("product_id".into(), product.clone());
                    current["pending_update"] = Value::Object(pending);
                    current["modified_at"] = json!("2027-01-15T12:00:00.000Z");
                }
            }
            Self::patch(&mut current, &step);
            Self::result(&step, current.clone())
        }
    }
}
#[async_trait]
impl ManagementContext for Probe {
    async fn resolve(&self, actor: &Actor) -> Result<Value, Error> {
        self.trace(json!({"kind":"context","actor":actor}));
        Self::result(&self.step("contexts"), Value::Null)
    }
}
#[async_trait]
impl SnapshotSink for Probe {
    async fn apply(&self, input: Value) -> Result<Value, Error> {
        self.trace(json!({"kind":"project","input":input}));
        Self::result(
            &self.step("projects"),
            json!({"outcome":"applied","replayed":false}),
        )
    }
}
#[async_trait]
impl CurrencyRequestSink for Probe {
    async fn record(&self, actor: &Actor, input: Value) -> Result<Value, Error> {
        self.trace(json!({"kind":"record","actor":actor,"input":input}));
        Self::result(
            &self.step("records"),
            json!({"status":"requires-checkout","providerChangeScheduled":false}),
        )
    }
}
#[async_trait]
impl RefundRenewalStore for Probe {
    async fn read(&self, input: &Value) -> Result<Value, Error> {
        self.trace(json!({"kind":"read","input":input}));
        Self::result(&self.step("reads"), Value::Null)
    }
    async fn confirm(&self, input: &Value, proof: Value) -> Result<Value, Error> {
        self.trace(json!({"kind":"confirm","input":input,"proof":proof}));
        Self::result(
            &self.step("confirms"),
            json!({"status":proof["status"],"replayed":false}),
        )
    }
    async fn project(&self, input: Value) -> Result<Value, Error> {
        self.apply(input).await
    }
}
fn config(raw: &Value) -> Enabled {
    Enabled {
        enabled: true,
        environment: raw["environment"].as_str().unwrap().into(),
        access_token: raw["accessToken"].as_str().unwrap().into(),
        webhook_secret: raw["webhookSecret"].as_str().unwrap().into(),
        app_url: raw["appUrl"].as_str().unwrap().into(),
        paid_products: raw["paidProducts"].clone(),
    }
}
async fn check(kind: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../forge-core/data/billing-renewal-reference.json"
    ))
    .unwrap();
    let mut failures = vec![];
    let mut count = 0;
    for case in fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["kind"] == kind)
    {
        count += 1;
        let probe = Arc::new(Probe {
            case: case.clone(),
            current: Mutex::new(case["state"].clone()),
            indexes: Mutex::new(HashMap::new()),
            trace: Mutex::new(vec![]),
        });
        let client = Arc::new(Client {
            config: config(&fixture["config"]),
            transport: probe.clone(),
        });
        let clock_probe = probe.clone();
        let clock = Arc::new(move || clock_probe.clock());
        let cancellation = Cancellation {
            client: client.clone(),
            context: probe.clone(),
            sink: probe.clone(),
        };
        let currency = CurrencyPlanner {
            client: client.clone(),
            context: probe.clone(),
            record: probe.clone(),
            project: probe.clone(),
            clock: clock.clone(),
        };
        let refund = RefundRenewal {
            client,
            store: probe.clone(),
            clock,
        };
        let actor: Actor = serde_json::from_value(case["actor"].clone()).unwrap();
        let mut results = vec![];
        for _ in 0..case["attempts"].as_u64().unwrap() {
            let result = match kind {
                "cancel" => cancellation.schedule(&actor).await,
                "currency" => {
                    currency
                        .request(&actor, case["requestId"].as_str().unwrap())
                        .await
                }
                _ => refund.reconcile(&case["identity"]).await,
            };
            results.push(match result {
                Ok(output) => json!({"valid":true,"output":output}),
                Err(error) => json!({"valid":false,"error":error.0}),
            });
        }
        if json!(results) != case["results"] {
            failures.push(format!(
                "{} results: {}; expected {}",
                case["name"],
                json!(results),
                case["results"]
            ));
        }
        let trace = json!(*probe.trace.lock().unwrap());
        if trace != case["trace"] {
            failures.push(format!(
                "{} trace: {trace}; expected {}",
                case["name"], case["trace"]
            ));
        }
    }
    assert!(count > 25);
    assert!(
        failures.is_empty(),
        "{} source mismatches (first ten):\n{}",
        failures.len(),
        failures.into_iter().take(10).collect::<Vec<_>>().join("\n")
    );
}
#[tokio::test]
async fn cancellation_preserves_live_authority_restrictions_confirmations_and_lost_response_retries()
 {
    check("cancel").await;
}
#[tokio::test]
async fn currency_intents_use_provider_country_recheck_binding_and_never_patch_the_provider() {
    check("currency").await;
}
#[tokio::test]
async fn refund_renewal_preserves_revision_and_paid_contract_before_confirming_a_scheduled_product()
{
    check("refund").await;
}
