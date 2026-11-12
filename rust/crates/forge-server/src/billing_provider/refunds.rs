use super::{Client, Error, Operation, refund_renewal::RenewalSink, string, uuid};
use async_trait::async_trait;
use forge_core::billing::provider;
use serde_json::{Value, json};
use std::sync::Arc;

#[async_trait]
pub trait RefundSink: Send + Sync {
    async fn apply(&self, event: Value) -> Result<Value, Error>;
}
#[async_trait]
impl RefundSink for forge_store::billing::Service {
    async fn apply(&self, event: Value) -> Result<Value, Error> {
        Ok(self.apply_period_refund(event).await?)
    }
}
pub struct Refunds {
    pub client: Arc<Client>,
    pub sink: Arc<dyn RefundSink>,
    pub renewal: Option<Arc<dyn RenewalSink>>,
    pub basis_lookup: bool,
}
impl Refunds {
    pub async fn reconcile(&self, input: &Value) -> Result<Value, Error> {
        let id = uuid(&input["orderId"])?;
        let order = self
            .client
            .request(Operation::Order(id.into()), None, vec![])
            .await?;
        let workspace = string(&input["workspaceId"])?;
        let mut refund = provider::refund::verify(&self.client.config, workspace, id, &order)?;
        let needs_renewal = refund["scope"] == "upgrade" && refund["kind"] == "full";
        let mut basis = Value::Null;
        if needs_renewal && self.basis_lookup {
            // Preserve restrictive access even when base-payment evidence is
            // temporarily unavailable. A later retry may add the verified basis.
            if let Some(currency) = order["currency"]
                .as_str()
                .filter(|c| ["usd", "eur"].contains(c))
            {
                basis=self.client.find_starter_basis(&json!({
                    "workspaceId":workspace,"subscriptionId":refund["subscriptionId"],
                    "productId":self.client.config.paid_products["starter"][currency],"currency":currency,
                    "upgradeStart":refund["start"],"periodEnd":refund["end"]
                })).await.unwrap_or(Value::Null);
            }
        }
        if !basis.is_null() {
            refund["starterBasis"] = basis.clone();
        }
        let result = self
            .sink
            .apply(json!({"eventId":input["eventId"],"bodyHash":input["bodyHash"],"refund":refund}))
            .await?;
        if needs_renewal {
            let renewal = self
                .renewal
                .as_ref()
                .ok_or(Error("BILLING_REFUND_RENEWAL_CLIENT_REQUIRED"))?;
            renewal.reconcile(&json!({"workspaceId":workspace,"environment":self.client.config.environment,"subscriptionId":refund["subscriptionId"],"orderId":refund["orderId"]})).await?;
            if basis.is_null() {
                return Err(Error("BILLING_STARTER_BASE_RECONCILIATION_REQUIRED"));
            }
        }
        Ok(result)
    }
}
