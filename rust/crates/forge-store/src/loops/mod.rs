//! Shared-loop management and immutable run capture. Provider execution is kept
//! outside the command transaction and loop principals remain separately fenced.
use crate::{Database, StoreError, authority::current_actor, resource_policy as policy, security};
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    loops as contract,
};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;
mod authority;
mod command;
mod context;
mod directory;
mod dispatch;
mod execution;
mod scheduler;
mod webhook;
pub(crate) use authority::{agent_run_matches, current_from_env as current_loop_actor};
pub use dispatch::ExpiredRuns;
pub(crate) use execution::decision_reviewer;
pub use execution::{ClaimedRun, ExecutionResult, ExecutionState, Executor};
pub use scheduler::{DispatchOptions, DispatchReport};

#[derive(Clone)]
pub struct Options {
    pub enabled: bool,
    pub environment: HashMap<String, String>,
}
impl Options {
    pub fn from_environment(environment: HashMap<String, String>) -> Self {
        Self {
            enabled: contract::enabled(&json!(environment)),
            environment,
        }
    }
    pub fn from_env() -> Self {
        Self::from_environment(std::env::vars().collect())
    }
}
#[derive(Clone)]
pub struct Service {
    pub database: Database,
    pub options: Options,
    pub agents: Option<Arc<crate::agents::coordinator::Service>>,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}
impl Service {
    pub fn new(database: Database, options: Options) -> Self {
        Self {
            database,
            options,
            agents: None,
            now: Arc::new(Utc::now),
        }
    }
    fn time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis((self.now)().timestamp_millis()).expect("valid clock")
    }
    async fn can_enable(&self, actor: &Actor) -> Result<(), StoreError> {
        // Preflight also runs for command replay; credentials/catalogs can have
        // changed since the original receipt was committed.
        let mut tx = self.database.begin().await?;
        let actor = current_actor(&mut tx, actor).await?;
        tx.commit().await?;
        let flags = forge_core::agents::policy::features(&self.options.environment);
        let controls = forge_core::agents::policy::controls(&self.options.environment);
        if flags["agent_ui"] != true || flags["agent_eve_runtime"] != true {
            return Err(StoreError::LoopPolicy(
                "Cloud agent execution is disabled in this environment.",
            ));
        }
        if flags["agent_auto_openai"] != true
            || flags["agent_provider_openai"] != true
            || controls["allowedProviders"]
                .as_array()
                .is_some_and(|v| !v.iter().any(|v| v == "openai"))
        {
            return Err(StoreError::LoopPolicy(
                "Enable OpenAI Auto for this environment before enabling Loops.",
            ));
        }
        let env = json!(self.options.environment);
        let mut development = env.clone();
        development
            .as_object_mut()
            .unwrap()
            .remove("FORGE_LOOPS_ENABLED");
        if contract::enabled(&development) && env["AGENT_FAKE_RUNTIME_ENABLED"] == "true" {
            return Ok(());
        }
        let hosted = self
            .agents
            .as_ref()
            .and_then(|a| a.hosted.as_ref())
            .filter(|h| !h.runtimes.is_empty())
            .ok_or(StoreError::LoopPolicy(
                "Configure the cloud agent runtime before enabling Loops.",
            ))?;
        let models = hosted.models.catalog(&actor, true).await?;
        let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM model_connections WHERE workspace_id=$1 AND scope='workspace' AND status='ready'").bind(&actor.workspace_id).fetch_all(self.database.pool()).await?;
        let models: Vec<_> = models
            .into_iter()
            .filter(|m| {
                m["connectionId"]
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .is_some_and(|id| ids.contains(&id))
            })
            .collect();
        contract::resolve_model(&json!({"mode":"auto","message":"Check Loop execution readiness.","availableModels":models})).map_err(|_|StoreError::LoopPolicy("Configure a compatible workspace OpenAI cloud model with tools and reasoning support before enabling Loops."))?;
        Ok(())
    }
}
fn id(s: &str) -> Result<Uuid, StoreError> {
    if !forge_core::text::is_uuid(s) {
        return Err(StoreError::InvalidInput);
    }
    s.parse().map_err(|_| StoreError::InvalidInput)
}
fn value_id(v: &Value) -> Result<Uuid, StoreError> {
    id(v.as_str().ok_or(StoreError::InvalidInput)?)
}
fn stamp(v: DateTime<Utc>) -> String {
    contract::iso_timestamp(v)
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
async fn team_access(
    c: &mut PgConnection,
    a: &Actor,
    team: Uuid,
    enabled: bool,
) -> Result<String, StoreError> {
    if !enabled || !matches!(a.authentication, Authentication::Session { .. }) || a.scopes.is_some()
    {
        return Err(StoreError::Forbidden);
    }
    fence(c, a).await?;
    sqlx::query("SELECT id FROM team_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE")
        .bind(&a.workspace_id)
        .bind(&a.user_id)
        .fetch_all(&mut *c)
        .await?;
    policy::team(c, a, team).await?;
    Ok(
        sqlx::query_scalar(
            "SELECT visibility FROM teams WHERE workspace_id=$1 AND id=$2 FOR SHARE",
        )
        .bind(&a.workspace_id)
        .bind(team)
        .fetch_one(c)
        .await?,
    )
}
#[derive(Clone, FromRow)]
pub(crate) struct Definition {
    pub id: Uuid,
    pub workspace_id: String,
    pub team_id: Uuid,
    pub revision: i32,
    pub fields: Value,
    pub enabled: bool,
    pub enabled_by_id: Option<String>,
    pub webhook_secret_hash: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}
impl Definition {
    fn project(&self) -> Result<Value, StoreError> {
        let mut fields =
            contract::fields(self.fields.clone()).map_err(|_| StoreError::InvalidInput)?;
        fields.as_object_mut().unwrap().extend(json!({"id":self.id,"revision":self.revision,"enabled":self.enabled,"enabledById":self.enabled_by_id,"updatedAt":stamp(self.updated_at)}).as_object().unwrap().clone());
        Ok(fields)
    }
}
#[derive(Clone, FromRow)]
pub(crate) struct Run {
    pub id: Uuid,
    pub loop_id: Uuid,
    pub event_hash: String,
    pub event: Value,
    pub fields: Value,
    pub state: String,
    pub thread_id: Uuid,
    pub agent_run_id: Uuid,
    pub pending_decision: Option<Value>,
    pub result: Option<String>,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
}
async fn enqueue(
    c: &mut PgConnection,
    row: &Definition,
    key: &str,
    event: Value,
) -> Result<Run, StoreError> {
    let authorizer = row
        .enabled_by_id
        .as_deref()
        .filter(|_| row.enabled)
        .ok_or(StoreError::Forbidden)?;
    let hash = forge_core::canonical::command_input_hash(&event);
    let inserted:Option<Run>=sqlx::query_as("INSERT INTO loop_runs(workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *").bind(&row.workspace_id).bind(row.id).bind(row.revision).bind(key).bind(&hash).bind(event).bind(&row.fields).bind(authorizer).fetch_optional(&mut *c).await?;
    if let Some(run) = inserted {
        return Ok(run);
    }
    let old: Option<Run> =
        sqlx::query_as("SELECT * FROM loop_runs WHERE loop_id=$1 AND event_key=$2")
            .bind(row.id)
            .bind(key)
            .fetch_optional(c)
            .await?;
    old.filter(|r| r.event_hash == hash)
        .ok_or(StoreError::LoopPolicy(
            "The event identity was already used with different input.",
        ))
}
