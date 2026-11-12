//! Production capability gateway. SQL writes consume approvals inside canonical
//! commands; provider-backed artifact creation is supplied by its owning service.
use super::approval_service::{self, Binding};
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    teams::{self, Selector},
};
use async_trait::async_trait;
use chrono::Utc;
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    agents::{approval, capabilities as contract, contracts},
    canonical::javascript_stringify,
    teams::{TeamSettings, TeamSummary},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

#[async_trait]
pub trait ArtifactCreator: Send + Sync {
    /// Recheck current run/actor and publish bytes/metadata through the artifact
    /// service. Return only the public artifact projection, without storage keys.
    async fn create(&self, actor: &Actor, run: Uuid, input: Value) -> Result<Value, StoreError>;
}
#[derive(Clone)]
pub struct Gateway {
    database: Database,
    allowed: Option<HashSet<String>>,
    artifacts: Option<Arc<dyn ArtifactCreator>>,
}
impl Gateway {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            allowed: None,
            artifacts: None,
        }
    }
    pub fn with_allowed(mut self, allowed: Option<HashSet<String>>) -> Self {
        self.allowed = allowed;
        self
    }
    pub fn with_artifacts(mut self, artifacts: Arc<dyn ArtifactCreator>) -> Self {
        self.artifacts = Some(artifacts);
        self
    }
    pub fn descriptors(&self) -> &'static [Value] {
        contract::descriptors()
    }
    async fn authorize(
        &self,
        actor: &Actor,
        invocation: &Value,
        run: Uuid,
    ) -> Result<Actor, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = current_actor(&mut tx, actor).await?;
        if !crate::loops::agent_run_matches(&mut tx, &actor, run).await? {
            return Err(StoreError::Forbidden);
        }
        match invocation["capabilityId"].as_str().unwrap() {
            "teams.list" | "teams.get" | "workspace.describe" => {
                if !actor.has_scope(ApiScope::TeamsRead) {
                    return Err(StoreError::Forbidden);
                }
            }
            "teams.update" => {
                if !actor.can_manage_teams() || !actor.has_scope(ApiScope::TeamsRead) {
                    return Err(StoreError::Forbidden);
                }
                let slug = invocation["input"]["slug"]
                    .as_str()
                    .ok_or(StoreError::Forbidden)?;
                teams::get_in(&mut tx, &actor, &Selector::Slug(slug.into()))
                    .await?
                    .ok_or(StoreError::Forbidden)?;
            }
            "artifacts.create" => {
                if !actor.has_scope(ApiScope::AgentsWrite) {
                    return Err(StoreError::Forbidden);
                }
            }
            _ => return Err(StoreError::Forbidden),
        }
        tx.commit().await?;
        Ok(actor)
    }
    pub async fn invoke(&self, actor: &Actor, invocation: Value, run: Uuid) -> Value {
        let Ok(invocation) = contracts::capability(invocation, false) else {
            return invalid();
        };
        if !run_matches(actor, run) {
            return contract::failure(
                "RUN_BINDING_MISMATCH",
                "The run token does not match this invocation.",
            );
        }
        let Ok(actor) = self.authorize(actor, &invocation, run).await else {
            return contract::failure("FORBIDDEN", "The capability request was rejected.");
        };
        let id = invocation["capabilityId"].as_str().unwrap();
        if self
            .allowed
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(id))
        {
            return contract::failure(
                "POLICY_BLOCKED",
                "This capability is disabled by workspace policy.",
            );
        }
        let Some(descriptor) =
            contract::descriptor(id, invocation["capabilityVersion"].as_str().unwrap())
        else {
            return contract::failure(
                "CAPABILITY_NOT_FOUND",
                "The requested capability or version is unavailable.",
            );
        };
        if descriptor["risk"] != "read" && invocation.get("idempotencyKey").is_none() {
            return contract::failure(
                "IDEMPOTENCY_KEY_REQUIRED",
                "Write capabilities require an idempotency key.",
            );
        }
        let Ok(input) = contract::input(id, invocation["input"].clone()) else {
            return invalid();
        };
        if id == "teams.update" {
            return self.update(&actor, &invocation, &input, run).await;
        }
        let result = match id {
            "teams.list" => {
                teams::list(
                    &self.database,
                    &actor,
                    input.get("cursor").and_then(Value::as_str),
                    input["limit"].as_i64().unwrap(),
                )
                .await
            }
            "teams.get" => {
                let selector = if let Some(id) = input["id"].as_str() {
                    Selector::Id(id.parse().unwrap())
                } else {
                    Selector::Slug(input["slug"].as_str().unwrap().into())
                };
                teams::get(&self.database, &actor, &selector)
                    .await
                    .and_then(|row| serde_json::to_value(row).map_err(|_| StoreError::InvalidInput))
            }
            "workspace.describe" => self.describe(&actor).await,
            "artifacts.create" => match &self.artifacts {
                Some(service) => service.create(&actor, run, input).await,
                None => Err(StoreError::NotFound),
            },
            _ => unreachable!(),
        };
        let Ok(value) = result else {
            return failed();
        };
        let Ok(value) = contract::output(id, value) else {
            return invalid();
        };
        if javascript_stringify(&value).len() as u64
            > descriptor["maxResultBytes"].as_u64().unwrap()
        {
            return contract::failure(
                "CAPABILITY_RESULT_TOO_LARGE",
                "The capability result exceeds its inline size limit.",
            );
        }
        json!({"ok":true,"value":value})
    }
    async fn describe(&self, actor: &Actor) -> Result<Value, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = current_actor(&mut tx, actor).await?;
        if !actor.has_scope(ApiScope::TeamsRead) {
            return Err(StoreError::Forbidden);
        }
        let row: Option<(String, String, String)> =
            sqlx::query_as("SELECT id,name,slug FROM organization WHERE id=$1")
                .bind(&actor.workspace_id)
                .fetch_optional(&mut *tx)
                .await?;
        let (id, name, slug) = row.ok_or(StoreError::NotFound)?;
        tx.commit().await?;
        Ok(json!({"id":id,"name":name,"slug":slug,"actorRole":actor.workspace_role}))
    }
    async fn update(&self, actor: &Actor, invocation: &Value, parsed: &Value, run: Uuid) -> Value {
        let Ok(settings) = TeamSettings::parse(parsed["settings"].clone()) else {
            return invalid();
        };
        let operation = format!("capability:teams.update@1:{run}");
        let handler = Update {
            invocation,
            run,
            slug: parsed["slug"].as_str().unwrap(),
            settings,
        };
        match commands::execute(
            &self.database,
            actor,
            Command {
                key: invocation["idempotencyKey"].as_str().unwrap(),
                operation: &operation,
                input: &invocation["input"],
                status: 200,
            },
            &handler,
        )
        .await
        {
            Ok(result) => json!({"ok":true,"value":result.value}),
            Err(error) => match &error {
                StoreError::CommandReused => {
                    contract::failure("IDEMPOTENCY_KEY_CONFLICT", &error.to_string())
                }
                StoreError::CommandAmbiguous | StoreError::CommandResultUnavailable => {
                    contract::failure("IDEMPOTENCY_RECONCILIATION_REQUIRED", &error.to_string())
                }
                StoreError::CapabilityConflict { reused, message } => contract::failure(
                    if *reused {
                        "IDEMPOTENCY_KEY_CONFLICT"
                    } else {
                        "IDEMPOTENCY_RECONCILIATION_REQUIRED"
                    },
                    message,
                ),
                StoreError::Approval(error) => contract::failure(
                    serde_json::to_value(error.code).unwrap().as_str().unwrap(),
                    error.message,
                ),
                StoreError::Forbidden => contract::failure(
                    "FORBIDDEN",
                    "You do not have permission to perform this action.",
                ),
                StoreError::InvalidInput => invalid(),
                _ => failed(),
            },
        }
    }
}
fn invalid() -> Value {
    contract::failure(
        "INVALID_CAPABILITY_INPUT",
        "The capability input or output is invalid.",
    )
}
fn failed() -> Value {
    contract::failure(
        "CAPABILITY_EXECUTION_FAILED",
        "The capability execution failed.",
    )
}
fn run_matches(actor: &Actor, run: Uuid) -> bool {
    match &actor.authentication {
        Authentication::Agent { run_id, .. } => run_id.parse::<Uuid>().ok() == Some(run),
        _ => true,
    }
}
struct Update<'a> {
    invocation: &'a Value,
    run: Uuid,
    slug: &'a str,
    settings: TeamSettings,
}
#[derive(sqlx::FromRow)]
struct Legacy {
    input_hash: String,
    state: String,
    result: Option<String>,
}
#[async_trait]
impl CommandHandler for Update<'_> {
    type Output = TeamSummary;
    async fn before_actor(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<(), StoreError> {
        sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(&actor.workspace_id)
            .fetch_optional(connection)
            .await?
            .ok_or(StoreError::Forbidden)?;
        Ok(())
    }
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&TeamSummary>,
    ) -> Result<(), StoreError> {
        if !crate::loops::agent_run_matches(connection, actor, self.run).await? {
            return Err(StoreError::Forbidden);
        }
        if let Some(value) = value {
            contract::output(
                "teams.update",
                serde_json::to_value(value).map_err(|_| StoreError::InvalidInput)?,
            )
            .map_err(|_| StoreError::InvalidInput)?;
        }
        teams::authorize_capability_update(
            connection,
            actor,
            &value
                .map(|v| Selector::Id(v.id))
                .unwrap_or_else(|| Selector::Slug(self.slug.into())),
            value.is_none(),
        )
        .await
    }
    async fn legacy(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        command: &Command<'_>,
    ) -> Result<Option<TeamSummary>, StoreError> {
        let row:Option<Legacy>=sqlx::query_as("SELECT input_hash,state,result_json::text AS result FROM agent_capability_invocations WHERE workspace_id=$1 AND user_id=$2 AND run_id=$3 AND capability_id='teams.update' AND capability_version='1' AND idempotency_key=$4 FOR SHARE")
            .bind(&actor.workspace_id).bind(&actor.user_id).bind(self.run).bind(command.key).fetch_optional(connection).await?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.input_hash != approval::input_hash(command.input) {
            return Err(StoreError::CapabilityConflict {
                reused: true,
                message: "The invocation key was used with different input.",
            });
        }
        let result = row
            .result
            .as_deref()
            .map(forge_core::json::parse)
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?;
        if row.state != "completed" || !result.as_ref().is_some_and(|v| v["ok"] == true) {
            return Err(StoreError::CapabilityConflict {
                reused: false,
                message: "The legacy invocation requires reconciliation.",
            });
        }
        let value = contract::output("teams.update", result.unwrap()["value"].clone())
            .map_err(|_| StoreError::InvalidInput)?;
        serde_json::from_value(value)
            .map(Some)
            .map_err(|_| StoreError::InvalidInput)
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<TeamSummary>, StoreError> {
        let binding = Binding {
            run_id: self.run,
            capability_id: "teams.update".into(),
            capability_version: "1".into(),
            capability_input: self.invocation["input"].clone(),
        };
        let now = Utc::now();
        let id = if let Some(id) = self.invocation["approvalId"].as_str() {
            Some(id.parse().map_err(|_| StoreError::InvalidInput)?)
        } else {
            approval_service::find_approved_in(connection, actor, &binding, now)
                .await?
                .map(|a| a.id)
        }
        .ok_or_else(|| {
            StoreError::Approval(approval::Error::new(
                approval::Code::ApprovalNotFound,
                "This capability requires an approval.",
            ))
        })?;
        approval_service::consume_in(connection, actor, id, &binding, now).await?;
        let value = teams::update_in(
            connection,
            actor,
            &Selector::Slug(self.slug.into()),
            &self.settings,
        )
        .await?;
        let json = contract::output(
            "teams.update",
            serde_json::to_value(&value).map_err(|_| StoreError::InvalidInput)?,
        )
        .map_err(|_| StoreError::InvalidInput)?;
        if javascript_stringify(&json).len() > 64 * 1024 {
            return Err(StoreError::Conflict);
        }
        Ok(CommandResult {
            resource_type: "team".into(),
            resource_id: value.id.to_string(),
            events: vec![OutboxEvent {
                topic: "teams.updated.v1".into(),
                payload: json!({"teamId":value.id}).as_object().unwrap().clone(),
            }],
            value,
        })
    }
}
