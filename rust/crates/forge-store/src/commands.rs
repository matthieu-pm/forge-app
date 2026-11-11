//! Durable command execution against the reference schema. The receipt, SQL
//! effect, audit and outbox commit together. No provider calls belong here.

use crate::{StoreError, authority::current_actor};
use async_trait::async_trait;
use forge_core::{
    actor::{Actor, Authentication},
    canonical::{command_input, command_input_hash},
    features::{FeatureMode, FeatureRollouts, ProductFeature},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use std::sync::OnceLock;
use uuid::Uuid;

pub struct Command<'a> {
    pub key: &'a str,
    pub operation: &'a str,
    pub input: &'a Value,
    pub status: u16,
}

pub struct CommandResult<T> {
    pub value: T,
    pub resource_type: String,
    pub resource_id: String,
    pub events: Vec<OutboxEvent>,
}

pub struct OutboxEvent {
    pub topic: String,
    pub payload: serde_json::Map<String, Value>,
}

pub struct Executed<T> {
    pub replayed: bool,
    pub value: T,
}

#[async_trait]
pub trait CommandHandler: Send + Sync {
    type Output: Serialize + DeserializeOwned + Send + Sync;

    /// Runs before receipt lookup and again with the saved/resulting resource.
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&Self::Output>,
    ) -> Result<(), StoreError>;

    /// Existing pre-command-framework receipts are evidence of a prior effect.
    /// Replaying one must neither repeat the write nor invent audit/outbox rows.
    async fn legacy(
        &self,
        _connection: &mut PgConnection,
        _actor: &Actor,
        _command: &Command<'_>,
    ) -> Result<Option<Self::Output>, StoreError> {
        Ok(None)
    }

    /// SQL only, on the supplied connection. Do not start another transaction.
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Self::Output>, StoreError>;
}

#[derive(FromRow)]
struct Receipt {
    user_id: String,
    input_hash: String,
    response_body: Option<String>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryDetails {
    version: u8,
    #[serde(default = "command_origin")]
    origin: String,
    #[serde(default)]
    changes: Vec<HistoryChange>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryChange {
    field: String,
    from: String,
    to: String,
}

fn command_origin() -> String {
    "command".into()
}

fn bounded_text(text: &str, limit: usize) -> String {
    let mut length = 0;
    text.chars()
        .take_while(|character| {
            length += character.len_utf16();
            length <= limit
        })
        .collect()
}

fn history_envelope(value: Value, actor: &Actor, actor_name: &str) -> Result<Value, StoreError> {
    let history: HistoryDetails =
        serde_json::from_value(value).map_err(|_| StoreError::InvalidInput)?;
    if history.version != 1
        || !["command", "import"].contains(&history.origin.as_str())
        || history.changes.len() > 50
        || history.changes.iter().any(|change| {
            change.field.encode_utf16().count() > 100
                || change.from.encode_utf16().count() > 1000
                || change.to.encode_utf16().count() > 1000
        })
    {
        return Err(StoreError::InvalidInput);
    }
    let mut result = serde_json::to_value(history).map_err(|_| StoreError::InvalidInput)?;
    let kind = match actor.authentication {
        Authentication::Session { .. } => "session",
        Authentication::ApiKey { .. } => "apiKey",
        Authentication::Agent { .. } | Authentication::Loop { .. } => "agent",
    };
    result["actor"] =
        json!({"userId": actor.user_id, "name": bounded_text(actor_name, 200), "kind": kind});
    Ok(result)
}

pub async fn execute<H: CommandHandler>(
    pool: &crate::Database,
    actor: &Actor,
    command: Command<'_>,
    handler: &H,
) -> Result<Executed<H::Output>, StoreError> {
    if command.key.is_empty()
        || command.key.encode_utf16().count() > 255
        || command.operation.is_empty()
        || !(200..=299).contains(&command.status)
    {
        return Err(StoreError::InvalidInput);
    }
    let hash = command_input_hash(command.input);
    let principal = actor.command_principal();
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR KEY SHARE")
        .bind(&actor.workspace_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::Forbidden)?;
    let current = current_actor(&mut tx, actor).await?;
    handler.authorize(&mut tx, &current, None).await?;
    let (sla_enabled, sla_identity) = pool.sla_gate(&current.workspace_id);
    sqlx::query("SELECT set_config('forge.sla.workspace',$1,true),set_config('forge.sla.enabled',$2,true),set_config('forge.sla.identity',$3,true)")
        .bind(&current.workspace_id).bind(if sla_enabled { "on" } else { "off" }).bind(sla_identity).execute(&mut *tx).await?;
    let reservation: Option<(Uuid,)> = sqlx::query_as(
        "INSERT INTO command_receipts(workspace_id,user_id,principal,operation,command_key,input_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
    ).bind(&actor.workspace_id).bind(&actor.user_id).bind(&principal).bind(command.operation).bind(command.key).bind(&hash).fetch_optional(&mut *tx).await?;
    let Some((command_id,)) = reservation else {
        let receipt = sqlx::query_as::<_, Receipt>(
            "SELECT user_id,input_hash,response_body,completed_at FROM command_receipts WHERE workspace_id=$1 AND principal=$2 AND operation=$3 AND command_key=$4 FOR SHARE",
        ).bind(&actor.workspace_id).bind(&principal).bind(command.operation).bind(command.key).fetch_optional(&mut *tx).await?.ok_or(StoreError::CommandReused)?;
        if receipt.input_hash != hash || receipt.user_id != actor.user_id {
            return Err(StoreError::CommandReused);
        }
        if receipt.completed_at.is_none() {
            return Err(StoreError::CommandAmbiguous);
        }
        let body = receipt
            .response_body
            .ok_or(StoreError::CommandResultUnavailable)?;
        let value: H::Output =
            serde_json::from_str(&body).map_err(|_| StoreError::CommandResultUnavailable)?;
        handler.authorize(&mut tx, &current, Some(&value)).await?;
        tx.commit().await?;
        return Ok(Executed {
            replayed: true,
            value,
        });
    };
    if let Some(value) = handler.legacy(&mut tx, &current, &command).await? {
        tx.prepare().await?;
        sqlx::query("DELETE FROM command_receipts WHERE id=$1")
            .bind(command_id)
            .execute(&mut *tx)
            .await?;
        handler.authorize(&mut tx, &current, Some(&value)).await?;
        tx.commit().await?;
        return Ok(Executed {
            replayed: true,
            value,
        });
    }
    tx.prepare().await?;
    let result = handler.run(&mut tx, &current).await?;
    if result.resource_id.is_empty() || result.resource_type.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    let response_body =
        command_input(&serde_json::to_value(&result.value).map_err(|_| StoreError::InvalidInput)?);
    handler
        .authorize(&mut tx, &current, Some(&result.value))
        .await?;
    sqlx::query("INSERT INTO command_audit_events(workspace_id,command_id,actor_user_id,operation,resource_type,resource_id) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(&actor.workspace_id).bind(command_id).bind(&actor.user_id).bind(command.operation).bind(&result.resource_type).bind(&result.resource_id).execute(&mut *tx).await?;
    let actor_name: Option<(String,)> = sqlx::query_as("SELECT name FROM \"user\" WHERE id=$1")
        .bind(&current.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    for (ordinal, mut event) in result.events.into_iter().enumerate() {
        if event.topic.starts_with("issue.") {
            let history = history_envelope(
                event
                    .payload
                    .remove("history")
                    .unwrap_or_else(|| json!({"version": 1})),
                &current,
                actor_name
                    .as_ref()
                    .map(|(name,)| name.as_str())
                    .unwrap_or("Member"),
            )?;
            event.payload.insert("history".into(), history);
        }
        sqlx::query("INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())")
            .bind(&actor.workspace_id).bind(command_id).bind(i32::try_from(ordinal).map_err(|_| StoreError::InvalidInput)?).bind(event.topic).bind(Value::Object(event.payload)).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE command_receipts SET response_body=$1,response_status=$2,resource_type=$3,resource_id=$4,completed_at=clock_timestamp() WHERE id=$5")
        .bind(response_body).bind(i32::from(command.status)).bind(result.resource_type).bind(result.resource_id).bind(command_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Executed {
        replayed: false,
        value: result.value,
    })
}

pub(crate) fn sla_gate(workspace_id: &str) -> (bool, String) {
    static PROCESS_ID: OnceLock<Uuid> = OnceLock::new();
    let raw = std::env::var("FORGE_FEATURE_ROLLOUTS").ok();
    let rollouts = FeatureRollouts::parse(raw.as_deref()).unwrap_or_default();
    let enabled = rollouts.mode(ProductFeature::Sla, workspace_id, false) == FeatureMode::Enabled;
    let deployment = std::env::var("VERCEL_DEPLOYMENT_ID").unwrap_or_else(|_| {
        format!(
            "{}:{}",
            std::env::var("FORGE_SOURCE_REVISION").unwrap_or_else(|_| "local".into()),
            PROCESS_ID.get_or_init(Uuid::new_v4)
        )
    });
    let identity =
        json!({"deployment": deployment, "workspaceId": workspace_id, "enabled": enabled})
            .to_string();
    (
        enabled,
        format!("{:x}", Sha256::digest(identity.as_bytes())),
    )
}
