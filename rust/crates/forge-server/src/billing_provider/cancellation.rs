//! Schedule cancellation only after fresh authority and provider observation.
use super::reconciliation::SnapshotSink;
use super::{Client, Error, ManagementContext, Subscriptions, hash, hash_bytes, uuid};
use forge_core::{actor::Actor, billing};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct Cancellation {
    pub client: Arc<Client>,
    pub context: Arc<dyn ManagementContext>,
    pub sink: Arc<dyn SnapshotSink>,
}

impl Cancellation {
    pub async fn schedule(&self, actor: &Actor) -> Result<Value, Error> {
        let identity = billing::identity(actor)?;
        let context = self.context.resolve(actor).await?;
        if context.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if context["workspaceId"] != identity["workspaceId"] {
            return Err(Error("BILLING_ACTOR_WORKSPACE_MISMATCH"));
        }
        let id = uuid(&context["subscriptionId"])?;
        let mut current = self.client.get(id).await?;
        let before =
            billing::provider::snapshot(&self.client.config, &actor.workspace_id, id, &current)?;
        let fresh = self.context.resolve(actor).await?;
        if fresh.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if fresh["workspaceId"] != context["workspaceId"] || fresh["subscriptionId"] != id {
            return Err(Error("BILLING_SUBSCRIPTION_CONFLICT"));
        }
        if !before["unsupportedPauseAt"].is_null() {
            let event_id = format!(
                "forge.cancel.pause.{id}.{}",
                super::string(&before["updatedAt"])?
            );
            self.sink.apply(json!({"eventId":event_id,"bodyHash":hash_bytes(event_id.as_bytes()),"snapshot":before,"actor":actor})).await?;
        }
        if before["cancelAtPeriodEnd"] != true && before["terminatedAt"].is_null() {
            self.client
                .update(id, json!({"cancel_at_period_end":true}))
                .await?;
            current = self.client.get(id).await?;
        }
        let snapshot =
            billing::provider::snapshot(&self.client.config, &actor.workspace_id, id, &current)?;
        if snapshot["terminatedAt"].is_null()
            && (snapshot["cancelAtPeriodEnd"] != true
                || snapshot["currentPeriodEnd"] != before["currentPeriodEnd"])
        {
            return Err(Error("BILLING_CANCELLATION_NOT_CONFIRMED"));
        }
        let event_id = format!(
            "forge.cancel.{id}.{}",
            super::string(&snapshot["updatedAt"])?
        );
        let body_hash = hash(
            &json!({"operation":"cancel-at-period-end","workspaceId":context["workspaceId"],"subscriptionId":id,"periodEnd":snapshot["currentPeriodEnd"]}),
        );
        let result = self
            .sink
            .apply(
                json!({"eventId":event_id,"bodyHash":body_hash,"snapshot":snapshot,"actor":actor}),
            )
            .await?;
        if result.is_null() {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        if result["outcome"] == "stale" {
            return Err(Error("BILLING_CANCELLATION_RECONCILIATION_REQUIRED"));
        }
        Ok(
            json!({"status":if snapshot["status"]=="canceled"{"canceled"}else{"scheduled"},"cancellationEffectiveAt":if snapshot["terminatedAt"].is_null(){&snapshot["currentPeriodEnd"]}else{&snapshot["terminatedAt"]}}),
        )
    }
}
