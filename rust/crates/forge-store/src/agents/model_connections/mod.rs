//! Model connection authority and atomic catalog publication. Provider I/O and
//! credential encryption run outside SQL transactions; publication reauthorizes.
use crate::{Database, StoreError, authority::current_actor};
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope},
    agents::{
        models,
        providers::{self as policy, Code, Discovery, DiscoveryInput, Error, Model},
    },
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use uuid::Uuid;
mod records;
mod refresh;
mod registry;
mod runtime;
use records::*;

pub trait Vault: Send + Sync {
    fn seal(&self, secret: &str, context: &str) -> Result<String, Error>;
    fn open(&self, reference: &str, context: &str) -> Result<String, Error>;
}
impl Vault for forge_identity::model_vault::Vault {
    fn seal(&self, secret: &str, context: &str) -> Result<String, Error> {
        self.seal(secret, context).map_err(|_| {
            Error::new(
                Code::VaultUnavailable,
                "The credential vault is unavailable.",
            )
        })
    }
    fn open(&self, reference: &str, context: &str) -> Result<String, Error> {
        self.open(reference, context).map_err(|_| {
            Error::new(
                Code::VaultUnavailable,
                "The credential vault could not open this connection.",
            )
        })
    }
}
#[derive(Clone)]
pub struct Service {
    pub database: Database,
    pub discovery: Arc<dyn Discovery>,
    pub vault: Arc<dyn Vault>,
    pub allowed_providers: Option<HashSet<String>>,
    pub managed_environment: HashMap<String, String>,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}
impl Service {
    pub fn new(database: Database, discovery: Arc<dyn Discovery>, vault: Arc<dyn Vault>) -> Self {
        Self {
            database,
            discovery,
            vault,
            allowed_providers: None,
            managed_environment: HashMap::new(),
            now: Arc::new(Utc::now),
        }
    }
    fn time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis((self.now)().timestamp_millis()).unwrap()
    }
    fn provider_allowed(&self, provider: &str) -> Result<(), StoreError> {
        if self
            .allowed_providers
            .as_ref()
            .is_some_and(|p| !p.contains(provider))
        {
            return Err(error(
                Code::PolicyBlocked,
                "This model provider is disabled by workspace policy.",
            ));
        }
        Ok(())
    }
    async fn actor(&self, actor: &Actor, scope: ApiScope) -> Result<Actor, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, scope).await?;
        tx.commit().await?;
        Ok(actor)
    }
    pub async fn list(&self, actor: &Actor) -> Result<Vec<Value>, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, ApiScope::ModelConnectionsRead).await?;
        let rows:Vec<Connection>=sqlx::query_as("SELECT c.* FROM model_connections c WHERE c.workspace_id=$1 AND (c.scope='workspace' OR c.user_id=$2) AND (NOT $3 OR (c.scope='workspace' AND c.locality='server-capable' AND c.execution_kind='forge-native')) ORDER BY c.updated_at DESC").bind(&actor.workspace_id).bind(&actor.user_id).bind(server_only(&actor)).fetch_all(&mut *tx).await?;
        let mut results = Vec::new();
        for row in rows {
            let mut value = summary(&mut tx, &row).await?;
            if self.provider_allowed(&row.provider).is_err() {
                value["status"] = json!("policy-blocked");
                value["statusReason"] =
                    json!("This model provider is disabled by deployment policy.");
            }
            results.push(value);
        }
        tx.commit().await?;
        Ok(results)
    }
    pub async fn create(&self, actor: &Actor, input: Value) -> Result<Value, StoreError> {
        let actor = self.actor(actor, ApiScope::ModelConnectionsWrite).await?;
        let input = models::create_connection(input).map_err(|_| StoreError::InvalidInput)?;
        let scope = input["scope"].as_str().unwrap();
        write_allowed(&actor, scope)?;
        let provider = input["provider"].as_str().unwrap();
        self.provider_allowed(provider)?;
        let endpoint = if let Some(value) = input["endpointUrl"].as_str() {
            Some(self.discovery.validate_endpoint(value).await.map_err(|_| {
                error(
                    Code::InvalidEndpoint,
                    "The custom endpoint must use HTTPS and resolve only to public addresses.",
                )
            })?)
        } else {
            None
        };
        let secret = input["apiKey"].as_str().unwrap();
        let discovery = DiscoveryInput {
            provider: provider.into(),
            api_key: secret.into(),
            endpoint_url: endpoint.clone(),
            model_ids: input
                .get("modelIds")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| StoreError::InvalidInput)?
                .unwrap_or_default(),
        };
        let catalog = self.discovery.discover(&discovery).await.map_err(|_| {
            error(
                Code::DiscoveryFailed,
                "Forge could not authenticate with this provider or discover its models.",
            )
        })?;
        if catalog.is_empty() {
            return Err(error(
                Code::DiscoveryFailed,
                "The provider did not return any compatible text models.",
            ));
        }
        let id = Uuid::new_v4();
        let reference = self.vault.seal(secret, &context(&actor, id)).map_err(|_| {
            error(
                Code::VaultUnavailable,
                "The credential vault is unavailable.",
            )
        })?;
        let now = self.time();
        let mut tx = self.database.begin().await?;
        let actor = publication_actor(&mut tx, &actor, ApiScope::ModelConnectionsWrite).await?;
        write_allowed(&actor, scope)?;
        self.provider_allowed(provider)?;
        tx.prepare().await?;
        let suffix = String::from_utf16_lossy(
            &secret.encode_utf16().collect::<Vec<_>>()
                [secret.encode_utf16().count().saturating_sub(4)..],
        );
        let row:Connection=sqlx::query_as("INSERT INTO model_connections(id,workspace_id,user_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,masked_credential_suffix,secret_reference,endpoint_url,status,discovered_at,last_health_checked_at,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'api-key','forge-native','server-capable','pay-as-you-go','forge-server-vault',$6,$7,$8,$9,'ready',$10,$10,$11,$10,$10) RETURNING *").bind(id).bind(&actor.workspace_id).bind(if scope=="personal"{Some(&actor.user_id)}else{None}).bind(scope).bind(provider).bind(input["displayName"].as_str().unwrap()).bind(suffix).bind(reference).bind(endpoint).bind(now).bind(&actor.user_id).fetch_one(&mut *tx).await?;
        replace_catalog(&mut tx, &row, &catalog, now).await?;
        let result = summary(&mut tx, &row).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn delete(&self, actor: &Actor, id: Uuid) -> Result<Value, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = publication_actor(&mut tx, actor, ApiScope::ModelConnectionsWrite).await?;
        let row = accessible(&mut tx, &actor, id, true).await?;
        write_allowed(&actor, &row.scope)?;
        tx.prepare().await?;
        // ON DELETE SET NULL alone violates the manual preference constraint.
        // Deleting the preference restores its default selection and records a
        // replayable deletion before the referenced connection is removed.
        sqlx::query("DELETE FROM thread_model_preferences WHERE selected_connection_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM model_connections WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(json!({"ok":true}))
    }
}
fn error(code: Code, message: &'static str) -> StoreError {
    Error::new(code, message).into()
}
fn context(actor: &Actor, id: Uuid) -> String {
    format!("{}:{id}", actor.workspace_id)
}
async fn publication_actor(
    conn: &mut PgConnection,
    actor: &Actor,
    scope: ApiScope,
) -> Result<Actor, StoreError> {
    // Take the workspace fence before agent-run authority locks, matching the
    // approval and command services. Connection deletion can update run FKs.
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(&actor.workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    if exists.is_none() {
        return Err(StoreError::Forbidden);
    }
    live(conn, actor, scope).await
}
async fn live(
    conn: &mut PgConnection,
    actor: &Actor,
    scope: ApiScope,
) -> Result<Actor, StoreError> {
    let actor = current_actor(conn, actor).await?;
    if !actor.has_scope(scope) {
        return Err(StoreError::Forbidden);
    }
    Ok(actor)
}
fn write_allowed(actor: &Actor, scope: &str) -> Result<(), StoreError> {
    if !actor.has_scope(ApiScope::ModelConnectionsWrite)
        || (scope == "workspace" && !actor.can_manage_workspace_models())
    {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}
fn iso(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn server_only(actor: &Actor) -> bool {
    actor.loop_scope.is_some()
        || matches!(
            actor.authentication,
            forge_core::actor::Authentication::Loop { .. }
        )
}
