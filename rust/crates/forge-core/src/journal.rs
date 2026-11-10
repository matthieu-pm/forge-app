//! The existing independently signed deletion-journal format. Preserve field
//! order: signatures and source identities were originally made with JSON.stringify.

use async_trait::async_trait;
use futures_core::Stream;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::pin::Pin;

#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("RECOVERY_JOURNAL_RECORD_SHAPE")]
    Shape,
    #[error("RECOVERY_JOURNAL_SIGNATURE")]
    Signature,
    #[error("RECOVERY_JOURNAL_UNAVAILABLE")]
    Unavailable,
    #[error("RECOVERY_JOURNAL_EFFECT_CONFLICT")]
    Conflict,
    #[error("RECOVERY_JOURNAL_SOURCE")]
    Source,
    #[error("RECOVERY_JOURNAL_PUBLICATION_PENDING")]
    PublicationPending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalSource {
    pub branch_id: String,
    pub host: String,
    pub database: String,
    pub store_id: String,
}

impl JournalSource {
    pub fn validate(&self) -> Result<(), JournalError> {
        if !self.branch_id.starts_with("br-")
            || !self.host.ends_with(".neon.tech")
            || self.database.is_empty()
            || !self.store_id.strip_prefix("store_").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        {
            return Err(JournalError::Source);
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<String, JournalError> {
        self.validate()?;
        Ok(hex::encode(Sha256::digest(
            serde_json::to_vec(self).map_err(|_| JournalError::Shape)?,
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryAction {
    Delete,
    Patch,
    Upsert,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryEvent {
    pub id: String,
    pub sequence: i64,
    pub table: String,
    pub key: Map<String, Value>,
    pub action: RecoveryAction,
    #[serde(deserialize_with = "required_nullable")]
    pub patch: Option<Map<String, Value>>,
    #[serde(deserialize_with = "required_nullable")]
    pub storage_reference: Option<String>,
    pub at: String,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

const PATCH_FIELDS: &[&str] = &[
    "deleted_at",
    "expires_at",
    "enabled",
    "revoked_at",
    "role",
    "visibility",
    "status",
    "archived_at",
    "permissions",
    "scopes",
    "active_organization_id",
    "secret",
    "secret_reference",
    "access_token",
    "refresh_token",
    "password",
    "oauth_verifier",
    "oauth_state_hash",
    "transcript",
    "state",
    "email_verified",
    "version",
    "invite_links_enabled",
    "invite_link_version",
    "google_authentication_enabled",
    "email_passkey_authentication_enabled",
    "invitation_policy",
    "team_creation_policy",
    "workspace_labels_policy",
    "workspace_templates_policy",
    "loops_policy",
    "api_key_creation_policy",
    "agent_guidance_policy",
    "restrict_file_uploads",
    "allowed_upload_types",
    "review_third_party_applications",
    "reduce_support_pii",
    "block_guest_agent_access",
    "share_ai_usage_data",
    "agent_web_search_enabled",
    "external_loop_sources_enabled",
    "mcp_servers_enabled",
    "hipaa_enabled",
    "retention_days",
];
const SECRET_FIELDS: &[&str] = &[
    "secret",
    "secret_reference",
    "access_token",
    "refresh_token",
    "password",
    "oauth_verifier",
    "oauth_state_hash",
];

fn identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.hyphenated().to_string().eq_ignore_ascii_case(value)
            && (id.is_nil()
                || id.is_max()
                || (id.get_variant() == uuid::Variant::RFC4122
                    && (1..=8).contains(&id.get_version_num())))
    })
}
fn timestamp(value: &str) -> bool {
    value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

impl RecoveryEvent {
    pub fn validate(&self) -> Result<(), JournalError> {
        if !uuid(&self.id)
            || self.sequence <= 0
            || !identifier(&self.table)
            || self.key.is_empty()
            || self.key.iter().any(|(key, value)| {
                !identifier(key)
                    || !(value.is_string()
                        || value.is_number()
                        || value.is_boolean()
                        || value.is_null())
            })
            || !timestamp(&self.at)
        {
            return Err(JournalError::Shape);
        }
        if (self.action == RecoveryAction::Delete && self.patch.is_some())
            || (self.action != RecoveryAction::Delete
                && self.patch.as_ref().is_none_or(Map::is_empty))
        {
            return Err(JournalError::Shape);
        }
        if let Some(patch) = &self.patch
            && patch.iter().any(|(key, value)| {
                !PATCH_FIELDS.contains(&key.as_str())
                    || (SECRET_FIELDS.contains(&key.as_str()) && !value.is_null())
                    || (key == "transcript" && value != &serde_json::json!([]))
            })
        {
            return Err(JournalError::Shape);
        }
        if self.action == RecoveryAction::Upsert
            && (!["workspace_security_settings", "call_settings"].contains(&self.table.as_str())
                || self.key.len() != 1
                || !self.key.contains_key("workspace_id")
                || (self.table == "call_settings"
                    && self.patch.as_ref().is_none_or(|patch| {
                        patch.len() != 1 || !patch.contains_key("retention_days")
                    })))
        {
            return Err(JournalError::Shape);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JournalKind {
    Prepared,
    Chunk,
    Completed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalRecord {
    pub version: u8,
    pub source: JournalSource,
    pub operation_id: String,
    pub at: String,
    pub kind: JournalKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<RecoveryEvent>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks: Option<Vec<String>>,
}

impl JournalRecord {
    pub fn same_effect_as(&self, other: &Self) -> Result<bool, JournalError> {
        self.validate()?;
        other.validate()?;
        let mut existing = self.clone();
        existing.at = other.at.clone();
        Ok(crate::canonical::javascript_stringify(
            &serde_json::to_value(existing).map_err(|_| JournalError::Shape)?,
        ) == crate::canonical::javascript_stringify(
            &serde_json::to_value(other).map_err(|_| JournalError::Shape)?,
        ))
    }

    pub fn validate(&self) -> Result<(), JournalError> {
        self.source.validate()?;
        if self.version != 1 || !uuid(&self.operation_id) || !timestamp(&self.at) {
            return Err(JournalError::Shape);
        }
        match self.kind {
            JournalKind::Prepared | JournalKind::Aborted
                if self.events.is_some() || self.chunks.is_some() =>
            {
                return Err(JournalError::Shape);
            }
            JournalKind::Chunk
                if self
                    .events
                    .as_ref()
                    .is_none_or(|events| events.len() > 1000)
                    || self.chunks.is_some() =>
            {
                return Err(JournalError::Shape);
            }
            JournalKind::Completed
                if self.events.is_some()
                    || self.chunks.as_ref().is_none_or(|chunks| {
                        chunks
                            .iter()
                            .enumerate()
                            .any(|(index, name)| name != &format!("chunk-{index}.json"))
                    }) =>
            {
                return Err(JournalError::Shape);
            }
            _ => {}
        }
        if let Some(events) = &self.events {
            for event in events {
                event.validate()?;
            }
        }
        Ok(())
    }
    pub fn signed(&self, key: &[u8]) -> Result<Value, JournalError> {
        self.validate()?;
        let bytes = crate::canonical::javascript_stringify(
            &serde_json::to_value(self).map_err(|_| JournalError::Shape)?,
        )
        .into_bytes();
        let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| JournalError::Signature)?;
        mac.update(&bytes);
        let signature = hex::encode(mac.finalize().into_bytes());
        let mut value = serde_json::to_value(self).map_err(|_| JournalError::Shape)?;
        value["signature"] = Value::String(signature);
        Ok(value)
    }
    pub fn verify(value: Value, key: &[u8]) -> Result<Self, JournalError> {
        let mut object = value.as_object().cloned().ok_or(JournalError::Shape)?;
        let signature = object
            .remove("signature")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or(JournalError::Signature)?;
        if signature.len() != 64
            || !signature
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(JournalError::Signature);
        }
        let record: Self =
            serde_json::from_value(Value::Object(object)).map_err(|_| JournalError::Shape)?;
        record.validate()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| JournalError::Signature)?;
        mac.update(
            crate::canonical::javascript_stringify(
                &serde_json::to_value(&record).map_err(|_| JournalError::Shape)?,
            )
            .as_bytes(),
        );
        mac.verify_slice(&hex::decode(signature).map_err(|_| JournalError::Signature)?)
            .map_err(|_| JournalError::Signature)?;
        Ok(record)
    }
}

pub type EventBatches =
    Pin<Box<dyn Stream<Item = Result<Vec<RecoveryEvent>, JournalError>> + Send>>;

#[async_trait]
pub trait DeletionJournalBackend: Send + Sync {
    async fn prepare(&self, operation_id: &str, source: &JournalSource)
    -> Result<(), JournalError>;
    async fn complete(
        &self,
        operation_id: &str,
        source: &JournalSource,
        events: EventBatches,
    ) -> Result<(), JournalError>;
    async fn abort(&self, operation_id: &str, source: &JournalSource) -> Result<(), JournalError>;
}
