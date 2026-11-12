//! Internal Polar adapters. Public routes remain disabled until the complete
//! verified-event and renewal orchestration is qualified.
use async_trait::async_trait;
use forge_core::billing::configuration::Enabled;
use serde::Serialize;
use serde_json::Value;
use std::{fmt, sync::Arc};
pub mod checkout;
pub mod reconciliation;
mod transport;
pub use transport::{HttpTransport, build_request};

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
        self.transport
            .execute(request, &self.config.access_token)
            .await
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
