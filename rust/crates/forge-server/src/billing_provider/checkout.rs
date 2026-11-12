//! Prepared hosted-session adapters. The caller owns current workspace authority
//! and billing-country resolution; returned URLs never grant paid access.
use super::{Client, Error, Operation};
use async_trait::async_trait;
use forge_core::{actor::Actor, billing};
use serde_json::{Value, json};
use std::sync::Arc;

#[async_trait]
pub trait Context: Send + Sync {
    async fn resolve(&self, actor: &Actor) -> Result<Value, Error>;
}

pub struct Checkout {
    pub client: Arc<Client>,
    pub context: Arc<dyn Context>,
}

fn hosted_url(value: &Value) -> Result<String, Error> {
    let url = url::Url::parse(value.as_str().ok_or(Error("INVALID_BILLING_INPUT"))?)
        .map_err(|_| Error("INVALID_BILLING_INPUT"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
    {
        return Err(Error("Polar returned an invalid hosted session URL."));
    }
    Ok(url.into())
}

impl Checkout {
    pub async fn create_checkout(&self, actor: &Actor, plan: &str) -> Result<Value, Error> {
        let identity = billing::identity(actor)?;
        billing::schema("selfServePlan", json!(plan))?;
        let context = self.context.resolve(actor).await?;
        if context["workspaceId"] != identity["workspaceId"] {
            return Err(Error(
                "Billing context does not match the active workspace.",
            ));
        }
        let seats = billing::safe_integer(&context["billableMembers"], 1)?;
        let location = billing::country(&context["billingCountry"])?;
        let country = &location["country"];
        let currency = location["currency"].as_str().expect("validated currency");
        billing::evaluate("price", &json!({"plan": plan, "members": seats})).map_err(|e| {
            if e.0 == "BILLING_INTEGER_OVERFLOW" {
                Error("Workspace price exceeds the supported range.")
            } else {
                e.into()
            }
        })?;
        let product_id = self.client.config.paid_products[plan][currency]
            .as_str()
            .ok_or(Error("INVALID_BILLING_CONFIGURATION"))?;
        let product = self
            .client
            .request(Operation::Product(product_id.into()), None, vec![])
            .await?;
        billing::provider::catalog::catalog(
            &product,
            &json!({"productId": product_id, "plan": plan, "currency": currency}),
        )?;
        // The resolver must verify live authority again after provider I/O.
        let fresh = self.context.resolve(actor).await?;
        if fresh["workspaceId"] != context["workspaceId"]
            || billing::safe_integer(&fresh["billableMembers"], 1)? != seats
            || billing::country(&fresh["billingCountry"])?["country"] != *country
        {
            return Err(Error("BILLING_CHECKOUT_CONTEXT_CHANGED"));
        }
        let result = self
            .client
            .request(
                Operation::Checkout,
                Some(json!({
                    "products": [product_id],
                    "seats": seats,
                    "min_seats": seats,
                    "max_seats": seats,
                    "currency": currency,
                    "customer_billing_address": {"country": country},
                    "require_billing_address": true,
                    "allow_discount_codes": false,
                    "allow_trial": false,
                    "external_customer_id": identity["externalCustomerId"],
                    "metadata": {
                        "workspace_id": identity["workspaceId"],
                        "actor_user_id": identity["actorUserId"],
                        "plan": plan,
                        "billing_country": country,
                    },
                    "success_url": format!("{}/settings/billing?checkout=pending", self.client.config.app_url),
                    "return_url": format!("{}/settings/billing", self.client.config.app_url),
                })),
                vec![],
            )
            .await?;
        let mut output = serde_json::Map::new();
        // The owning adapter passes through the provider's ID without requiring
        // a UUID. Preserve its JSON omission when absent as well.
        if let Some(id) = result.get("id") {
            output.insert("id".into(), id.clone());
        }
        output.insert("url".into(), json!(hosted_url(&result["url"])?));
        output.insert("status".into(), json!("pending"));
        Ok(Value::Object(output))
    }

    pub async fn create_portal(&self, actor: &Actor) -> Result<Value, Error> {
        let identity = billing::identity(actor)?;
        self.portal_context(actor, &identity).await?;
        let result = self
            .client
            .request(
                Operation::Portal,
                Some(json!({
                    "external_customer_id": identity["externalCustomerId"],
                    "return_url": format!("{}/settings/billing", self.client.config.app_url),
                })),
                vec![],
            )
            .await?;
        // Revocation after session creation must also prevent disclosure.
        self.portal_context(actor, &identity).await?;
        Ok(json!({"url": hosted_url(&result["customer_portal_url"])?}))
    }

    async fn portal_context(&self, actor: &Actor, identity: &Value) -> Result<(), Error> {
        let current = self.context.resolve(actor).await?;
        if current["workspaceId"] != identity["workspaceId"] {
            return Err(Error("BILLING_PORTAL_CONTEXT_CHANGED"));
        }
        Ok(())
    }
}
