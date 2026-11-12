//! Native Polar adapters. Signed event ingestion has independent default-off
//! configuration; management effects require a current trusted service context.
use async_trait::async_trait;
use forge_core::billing::configuration::Enabled;
use serde::Serialize;
use serde_json::Value;
use std::{fmt, sync::Arc};
pub mod cancellation;
pub mod checkout;
pub mod currency;
mod dates;
pub mod ecb;
pub mod plan;
pub mod reconciliation;
pub mod refund_renewal;
pub mod refunds;
pub mod replacement;
pub mod seats;
mod transport;
pub mod webhook;
pub use dates::{JsDate, coerce_date};
pub use transport::{HttpTransport, build_request};
pub type Clock = Arc<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send + Sync>;
pub fn system_clock() -> Clock {
    Arc::new(|| {
        chrono::DateTime::from_timestamp_millis(chrono::Utc::now().timestamp_millis())
            .expect("system clock")
    })
}

#[async_trait]
pub trait ManagementContext: Send + Sync {
    async fn resolve(&self, actor: &forge_core::actor::Actor) -> Result<Value, Error>;
}
#[async_trait]
pub trait Subscriptions: Send + Sync {
    async fn get(&self, id: &str) -> Result<Value, Error>;
    async fn update(&self, id: &str, body: Value) -> Result<Value, Error>;
}
#[async_trait]
impl Subscriptions for Client {
    async fn get(&self, id: &str) -> Result<Value, Error> {
        self.request(Operation::Subscription(id.into()), None, vec![])
            .await
    }
    async fn update(&self, id: &str, body: Value) -> Result<Value, Error> {
        self.request(Operation::UpdateSubscription(id.into()), Some(body), vec![])
            .await
    }
}
pub(super) fn hash_bytes(value: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value))
}
pub(super) fn hash(value: &Value) -> String {
    hash_bytes(forge_core::canonical::javascript_stringify(value).as_bytes())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}
impl From<forge_core::billing::Error> for Error {
    fn from(value: forge_core::billing::Error) -> Self {
        Self(value.0)
    }
}
impl From<forge_store::StoreError> for Error {
    fn from(value: forge_store::StoreError) -> Self {
        match value {
            forge_store::StoreError::Billing(error) => error.into(),
            _ => Self("BILLING_PERSISTENCE_UNAVAILABLE"),
        }
    }
}
#[derive(Clone, Debug)]
pub enum Operation {
    Product(String),
    Subscription(String),
    UpdateSubscription(String),
    ReadCheckout(String),
    Order(String),
    Orders,
    Checkout,
    Portal,
}
// Credentials are supplied separately and never appear in request diagnostics.
#[derive(Clone, Debug, Serialize)]
pub struct Request {
    pub method: String,
    pub url: String,
    pub body: Option<Value>,
}
#[async_trait]
pub trait Transport: Send + Sync {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error>;
}
pub struct Client {
    pub config: Enabled,
    pub transport: Arc<dyn Transport>,
}
impl Client {
    pub fn new(config: Enabled) -> Result<Self, Error> {
        Ok(Self {
            config,
            transport: Arc::new(HttpTransport::new()?),
        })
    }
    pub async fn request(
        &self,
        operation: Operation,
        body: Option<Value>,
        query: Vec<(String, String)>,
    ) -> Result<Value, Error> {
        if !self.config.enabled || forge_core::text::trim(&self.config.access_token).is_empty() {
            return Err(Error("INVALID_BILLING_CONFIGURATION"));
        }
        let request = build_request(&self.config.environment, operation, body, query)?;
        let value = self
            .transport
            .execute(request, &self.config.access_token)
            .await?;
        // The owning SDK's JSON values cross JavaScript's numeric boundary.
        // Normalize 1000.0/1e3 and integer precision before strict field equality.
        forge_core::json::parse(&forge_core::canonical::javascript_stringify(&value))
            .map_err(|_| Error("BILLING_PROVIDER_UNAVAILABLE"))
    }
}
fn string(value: &Value) -> Result<&str, Error> {
    value.as_str().ok_or(Error("INVALID_BILLING_INPUT"))
}
fn uuid(value: &Value) -> Result<&str, Error> {
    let value = string(value)?;
    if !forge_core::text::is_uuid(value) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    Ok(value)
}
