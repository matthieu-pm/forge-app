//! Authenticated billing read and the independently gated signed provider inbox.
use crate::billing_provider::{
    self as provider, Client, Error, ManagementContext,
    reconciliation::Reconciler,
    refund_renewal::RefundRenewal,
    refunds::Refunds,
    webhook::{Events, Handler},
};
use crate::{
    auth::{AuthError, configuration, cookie_token},
    state::AppState,
};
use async_trait::async_trait;
use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
};
use forge_core::{
    actor::Actor,
    billing::configuration::{self as billing_config, Config},
    features::{FeatureMode, FeatureRollouts, ProductFeature},
};
use forge_store::{authority, billing::Service};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

pub struct Settings {
    pub enabled: bool,
    pub rollouts: FeatureRollouts,
    pub webhook: Option<Arc<Handler>>,
}
struct EventServices {
    subscriptions: Reconciler,
    refunds: Refunds,
}
#[async_trait]
impl Events for EventServices {
    async fn subscription(&self, input: &Value) -> Result<Value, Error> {
        self.subscriptions.reconcile(input).await
    }
    async fn order(&self, input: &Value) -> Result<Value, Error> {
        self.subscriptions.reconcile_order(input).await
    }
    async fn refund(&self, input: &Value) -> Result<Value, Error> {
        self.refunds.reconcile(input).await
    }
}
impl Settings {
    pub fn configured(
        database: forge_store::Database,
        environment: &HashMap<String, String>,
    ) -> Result<Self, Error> {
        let enabled = environment
            .get("FORGE_BILLING_ENABLED")
            .is_some_and(|v| v == "true");
        let rollouts = FeatureRollouts::parse(
            environment
                .get("FORGE_FEATURE_ROLLOUTS")
                .map(String::as_str),
        )
        .map_err(|_| Error("INVALID_FEATURE_CONFIGURATION"))?;
        let mut settings = Self {
            enabled,
            rollouts,
            webhook: None,
        };
        if environment
            .get("FORGE_BILLING_WEBHOOKS_ENABLED")
            .is_none_or(|v| v != "true")
        {
            return Ok(settings);
        }
        let Config::Enabled(config) = billing_config::read(environment)? else {
            return Ok(settings);
        };
        let client = Arc::new(Client::new(*config)?);
        settings.webhook = Some(Arc::new(Self::handler(client, Service::new(database))));
        Ok(settings)
    }
    /// Shared production composition; injectable client transport permits real
    /// transaction tests without creating external provider-side effects.
    pub fn handler(client: Arc<Client>, service: Service) -> Handler {
        let clock = provider::system_clock();
        let renewal = Arc::new(RefundRenewal {
            client: client.clone(),
            store: Arc::new(service.clone()),
            clock: clock.clone(),
        });
        let subscriptions = Reconciler::new(client.clone(), Arc::new(service.clone()));
        let refunds = Refunds {
            client: client.clone(),
            sink: Arc::new(service),
            renewal: Some(renewal),
            basis_lookup: true,
        };
        Handler {
            client: Some(client),
            events: Arc::new(EventServices {
                subscriptions,
                refunds,
            }),
            now: clock,
        }
    }
}
pub struct PlanContext {
    pub service: Service,
    pub environment: String,
}
#[async_trait]
impl ManagementContext for PlanContext {
    async fn resolve(&self, actor: &Actor) -> Result<Value, Error> {
        Ok(self
            .service
            .plan_change_context(actor, &self.environment)
            .await?)
    }
}
pub struct CancellationContext {
    pub service: Service,
    pub environment: String,
}
#[async_trait]
impl ManagementContext for CancellationContext {
    async fn resolve(&self, actor: &Actor) -> Result<Value, Error> {
        Ok(self
            .service
            .cancellation_context(actor, &self.environment)
            .await?)
    }
}
pub struct ReplacementContext {
    pub service: Service,
    pub environment: String,
}
#[async_trait]
impl provider::replacement::Context for ReplacementContext {
    async fn resolve(&self, actor: &Actor, request: &str) -> Result<Value, Error> {
        Ok(self
            .service
            .replacement_anniversary_context(actor, request, &self.environment)
            .await?)
    }
}
pub(crate) async fn summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    let allowed = state.billing.as_ref().is_some_and(|settings| {
        settings.rollouts.mode(
            ProductFeature::Billing,
            &actor.workspace_id,
            settings.enabled,
        ) == FeatureMode::Enabled
    });
    if !allowed {
        return Err(AuthError(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Billing is unavailable in this workspace.",
        ));
    }
    Ok(Json(
        Service::new(database.clone())
            .billing_summary(&actor)
            .await?,
    ))
}
pub(crate) async fn webhook(State(state): State<AppState>, request: Request<Body>) -> Response {
    let Some(handler) = state
        .billing
        .as_ref()
        .filter(|settings| settings.enabled)
        .and_then(|settings| settings.webhook.as_ref())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    handler.handle(request).await
}
