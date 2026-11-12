use super::*;
use forge_core::billing::{calendar, provider};
use serde_json::json;

#[async_trait]
pub trait SnapshotSink: Send + Sync {
    async fn apply(&self, event: Value) -> Result<Value, Error>;
}
#[async_trait]
impl SnapshotSink for forge_store::billing::Service {
    async fn apply(&self, event: Value) -> Result<Value, Error> {
        Ok(self.apply_subscription_snapshot(event).await?)
    }
}
pub struct Reconciler {
    pub client: Arc<Client>,
    pub sink: Arc<dyn SnapshotSink>,
    /// Mirrors the owning adapter's optional order client. Native composition
    /// always enables it; absence can never fabricate payment evidence.
    pub order_proofs: bool,
}
impl Reconciler {
    pub fn new(client: Arc<Client>, sink: Arc<dyn SnapshotSink>) -> Self {
        Self {
            client,
            sink,
            order_proofs: true,
        }
    }
    pub async fn reconcile(&self, input: &Value) -> Result<Value, Error> {
        let subscription_id = uuid(&input["subscriptionId"])?;
        let subscription = self
            .client
            .request(
                Operation::Subscription(subscription_id.into()),
                None,
                vec![],
            )
            .await?;
        let workspace = string(&input["workspaceId"])?;
        let mut snapshot = provider::snapshot(
            &self.client.config,
            workspace,
            subscription_id,
            &subscription,
        )?;
        if input["unsupportedResume"] == true
            && snapshot["terminatedAt"].is_null()
            && snapshot["unsupportedPauseAt"].is_null()
        {
            snapshot["unsupportedPauseAt"] = snapshot["updatedAt"].clone();
        }
        if snapshot["plan"] == "plus"
            && (snapshot["status"] == "active"
                || snapshot["status"] == "canceled" && snapshot["cancelAtPeriodEnd"] == true)
            && snapshot["terminatedAt"].is_null()
            && snapshot["unsupportedPauseAt"].is_null()
            && self.order_proofs
        {
            let context = json!({
                "workspaceId":workspace,"subscriptionId":subscription_id,
                "productId":subscription["product_id"],"currency":subscription["currency"],
                "periodStart":snapshot["currentPeriodStart"],"periodEnd":snapshot["currentPeriodEnd"]
            });
            let proof = self.client.find_paid_upgrade(&context).await?;
            if !proof.is_null() {
                snapshot["paidUpgrade"] = proof;
            }
        }
        self.sink
            .apply(json!({
                "eventId":input["eventId"],"bodyHash":input["bodyHash"],"snapshot":snapshot
            }))
            .await
    }
    pub async fn reconcile_order(&self, input: &Value) -> Result<Value, Error> {
        if !self.order_proofs {
            return Err(Error("BILLING_ORDER_RECONCILIATION_REQUIRED"));
        }
        let id = uuid(&input["orderId"])?;
        let order = self
            .client
            .request(Operation::Order(id.into()), None, vec![])
            .await?;
        let workspace = string(&input["workspaceId"])?;
        if order.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if order["id"] != id {
            return Err(Error("BILLING_PROVIDER_IDENTITY_MISMATCH"));
        }
        let customer = order
            .get("customer")
            .filter(|v| !v.is_null())
            .ok_or(Error("INVALID_BILLING_INPUT"))?;
        if customer["external_id"] != format!("forge:workspace:{workspace}") {
            return Err(Error("BILLING_PROVIDER_IDENTITY_MISMATCH"));
        }
        let subscription = uuid(&order["subscription_id"])?;
        let mut input = input.clone();
        input["subscriptionId"] = json!(subscription);
        self.reconcile(&input).await
    }
}
impl Client {
    pub async fn find_paid_upgrade(&self, context: &Value) -> Result<Value, Error> {
        self.find_order_proof(context, false).await
    }
    pub async fn find_starter_basis(&self, context: &Value) -> Result<Value, Error> {
        self.find_order_proof(context, true).await
    }
    async fn find_order_proof(&self, context: &Value, starter: bool) -> Result<Value, Error> {
        for page in 1..=3 {
            // Query serialization order matches the pinned SDK's orders.list.
            let result = self
                .request(
                    Operation::Orders,
                    None,
                    vec![
                        ("product_id".into(), string(&context["productId"])?.into()),
                        (
                            "external_customer_id".into(),
                            format!("forge:workspace:{}", string(&context["workspaceId"])?),
                        ),
                        (
                            "subscription_id".into(),
                            string(&context["subscriptionId"])?.into(),
                        ),
                        ("status".into(), "paid".into()),
                        ("status".into(), "partially_refunded".into()),
                        (
                            "created_before".into(),
                            calendar::stamp(calendar::date(&context["periodEnd"])?),
                        ),
                        ("page".into(), page.to_string()),
                        ("limit".into(), "100".into()),
                        ("sorting".into(), "-created_at".into()),
                    ],
                )
                .await?;
            let items = result["items"]
                .as_array()
                .ok_or(Error("INVALID_BILLING_INPUT"))?;
            for order in items {
                let proof = if starter {
                    provider::orders::starter_basis(context, order)?
                } else {
                    provider::orders::upgrade(context, order)?
                };
                if !proof.is_null() {
                    return Ok(proof);
                }
            }
            let pagination = result
                .get("pagination")
                .filter(|v| !v.is_null())
                .ok_or(Error("INVALID_BILLING_INPUT"))?;
            if pagination["max_page"]
                .as_f64()
                .is_some_and(|n| f64::from(page) >= n)
            {
                break;
            }
        }
        Ok(Value::Null)
    }
}
