use async_trait::async_trait;
use chrono::{DateTime, Utc};
use forge_core::{actor::Actor, billing::configuration::Enabled};
use forge_server::billing_provider::{
    Client, Clock, Error, ManagementContext, Request, Subscriptions, Transport, plan::Changer,
    reconciliation::SnapshotSink, seats::Scheduler,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, LazyLock, Mutex},
};
use url::Url;

static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../forge-core/data/billing-plan-reference.json"
    ))
    .unwrap()
});

/// Every dependency call consumes the next actual TypeScript call. This checks
/// live authority reads, lost-response redrives and the precise side-effect
/// boundary as well as the returned result.
struct Probe {
    name: String,
    remaining: Mutex<VecDeque<Value>>,
}
impl Probe {
    fn call(&self, kind: &str, input: Value) -> Result<Value, Error> {
        let mut next = self
            .remaining
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("{}: unexpected {kind} call: {input}", self.name));
        let object = next.as_object_mut().unwrap();
        let output = object.remove("output");
        let error = object.remove("error");
        let mut expected = input;
        expected["kind"] = json!(kind);
        assert_eq!(next, expected, "{}: dependency ordering/input", self.name);
        if let Some(error) = error {
            return Err(Error(match error.as_str().unwrap() {
                "BILLING_PROVIDER_UNAVAILABLE" => "BILLING_PROVIDER_UNAVAILABLE",
                "BILLING_ACTOR_REVOKED" => "BILLING_ACTOR_REVOKED",
                "BILLING_PERSISTENCE_UNAVAILABLE" => "BILLING_PERSISTENCE_UNAVAILABLE",
                other => panic!("{}: unsupported fixture error {other}", self.name),
            }));
        }
        Ok(output.unwrap_or_else(|| panic!("{}: missing fixture result", self.name)))
    }
}
#[async_trait]
impl ManagementContext for Probe {
    async fn resolve(&self, actor: &Actor) -> Result<Value, Error> {
        self.call("context", json!({"actor":actor}))
    }
}
#[async_trait]
impl Subscriptions for Probe {
    async fn get(&self, id: &str) -> Result<Value, Error> {
        self.call("get", json!({"id":id}))
    }
    async fn update(&self, id: &str, body: Value) -> Result<Value, Error> {
        self.call("update", json!({"id":id,"body":body}))
    }
}
#[async_trait]
impl SnapshotSink for Probe {
    async fn apply(&self, input: Value) -> Result<Value, Error> {
        self.call("apply", json!({"input":input}))
    }
}
#[async_trait]
impl Transport for Probe {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        assert_eq!(token, "fixture-token", "{}", self.name);
        assert_eq!(request.method, "GET", "{}", self.name);
        assert!(request.body.is_none(), "{}", self.name);
        let url = Url::parse(&request.url).unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://sandbox-api.polar.sh"
        );
        assert_eq!(url.path(), "/v1/orders/", "{}", self.name);
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
        self.call("orders", json!({"query":query}))
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
async fn check(kind: &str) {
    for case in FIXTURES["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["kind"] == kind)
    {
        let name = case["name"].as_str().unwrap();
        let actor: Actor = serde_json::from_value(case["actor"].clone()).unwrap();
        let probe = Arc::new(Probe {
            name: name.into(),
            remaining: Mutex::new(case["trace"].as_array().unwrap().iter().cloned().collect()),
        });
        let client = Arc::new(Client {
            config: configuration(case.get("config").unwrap_or(&FIXTURES["config"])),
            transport: probe.clone(),
        });
        let clock_probe = probe.clone();
        let clock: Clock = Arc::new(move || {
            let value = clock_probe.call("clock", json!({})).unwrap();
            DateTime::parse_from_rfc3339(value.as_str().unwrap())
                .unwrap()
                .with_timezone(&Utc)
        });
        let changer = Changer {
            client: client.clone(),
            subscriptions: probe.clone(),
            context: probe.clone(),
            sink: probe.clone(),
            clock: clock.clone(),
        };
        let scheduler = Scheduler {
            client,
            subscriptions: probe.clone(),
            context: probe.clone(),
            clock,
        };
        for (attempt, expected) in case["outcomes"].as_array().unwrap().iter().enumerate() {
            let result = if kind == "plan" {
                changer
                    .change(&actor, case["target"].as_str().unwrap())
                    .await
            } else {
                scheduler.schedule(&actor).await
            };
            assert_eq!(
                result.is_ok(),
                expected["valid"].as_bool().unwrap(),
                "{name}, attempt {attempt}: {result:?}"
            );
            match result {
                Ok(value) => assert_eq!(value, expected["output"], "{name}, attempt {attempt}"),
                Err(error) => assert_eq!(
                    error.0,
                    expected["error"].as_str().unwrap(),
                    "{name}, attempt {attempt}"
                ),
            }
        }
        let remaining = probe.remaining.lock().unwrap();
        assert!(
            remaining.is_empty(),
            "{name}: source calls not consumed: {remaining:?}"
        );
    }
}

#[tokio::test]
async fn plan_changes_match_source_authority_effect_and_reconciliation_sequences() {
    check("plan").await;
}

#[tokio::test]
async fn seat_renewals_match_source_quantity_and_pending_change_sequences() {
    check("seats").await;
}
