//! Cloud adapter for Forge's independent deletion journal.

use async_trait::async_trait;
use aws_sdk_s3::{
    Client,
    config::{Credentials, Region},
    primitives::ByteStream,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{SecondsFormat, Utc};
use forge_core::journal::{
    DeletionJournalBackend, EventBatches, JournalError, JournalKind, JournalRecord, JournalSource,
    RecoveryEvent,
};
use futures_util::StreamExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

pub struct R2Journal {
    client: Client,
    signing_key: Vec<u8>,
    bucket: String,
}

pub struct JournalConfig {
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub signing_key: String,
}

impl R2Journal {
    pub fn new(config: JournalConfig) -> Result<Self, JournalError> {
        let hex_id = |value: &str| {
            value.len() == 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let signing_key = STANDARD
            .decode(&config.signing_key)
            .map_err(|_| JournalError::Shape)?;
        if !hex_id(&config.account_id)
            || !hex_id(&config.access_key_id)
            || config.bucket != "forge-recovery-deletion-journal"
            || config.secret_access_key.encode_utf16().count() < 32
            || signing_key.len() != 32
            || config.signing_key.len() != 44
            || !config.signing_key.ends_with('=')
        {
            return Err(JournalError::Shape);
        }
        let sdk = aws_sdk_s3::config::Builder::new()
            .behavior_version_latest()
            .region(Region::new("auto"))
            .endpoint_url(format!(
                "https://{}.r2.cloudflarestorage.com",
                config.account_id
            ))
            .credentials_provider(Credentials::new(
                config.access_key_id,
                config.secret_access_key,
                None,
                None,
                "forge-recovery",
            ))
            .force_path_style(true)
            .request_checksum_calculation(
                aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
            )
            .response_checksum_validation(
                aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
            )
            .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(3))
            .build();
        Ok(Self {
            client: Client::from_conf(sdk),
            signing_key,
            bucket: config.bucket,
        })
    }

    pub fn from_environment() -> Result<Option<Self>, JournalError> {
        if std::env::var("FORGE_RECOVERY_JOURNAL_ENABLED").as_deref() != Ok("true") {
            return Ok(None);
        }
        let variable = |name: &str| std::env::var(name).map_err(|_| JournalError::Shape);
        Self::new(JournalConfig {
            account_id: variable("FORGE_RECOVERY_R2_ACCOUNT_ID")?,
            bucket: variable("FORGE_RECOVERY_JOURNAL_BUCKET")?,
            access_key_id: variable("FORGE_RECOVERY_JOURNAL_ACCESS_KEY_ID")?,
            secret_access_key: variable("FORGE_RECOVERY_JOURNAL_SECRET_ACCESS_KEY")?,
            signing_key: variable("FORGE_RECOVERY_JOURNAL_SIGNING_KEY")?,
        })
        .map(Some)
    }

    fn prefix(source: &JournalSource, operation: &str) -> Result<String, JournalError> {
        Ok(format!(
            "journal/operations/{}/{operation}/",
            source.digest()?
        ))
    }
    fn pending(source: &JournalSource, operation: &str) -> Result<String, JournalError> {
        Ok(format!(
            "pending/operations/{}/{operation}/prepared.json",
            source.digest()?
        ))
    }
    fn record(source: &JournalSource, operation: &str, kind: JournalKind) -> JournalRecord {
        JournalRecord {
            version: 1,
            source: source.clone(),
            operation_id: operation.into(),
            at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            kind,
            events: None,
            chunks: None,
        }
    }

    async fn write(&self, record: &JournalRecord, name: &str) -> Result<(), JournalError> {
        let key = if record.kind == JournalKind::Prepared {
            Self::pending(&record.source, &record.operation_id)?
        } else {
            format!(
                "{}{name}",
                Self::prefix(&record.source, &record.operation_id)?
            )
        };
        let bytes = serde_json::to_vec(&record.signed(&self.signing_key)?)
            .map_err(|_| JournalError::Shape)?;
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(&key)
                .body(ByteStream::from(bytes))
                .if_none_match("*")
                .send(),
        )
        .await
        .map_err(|_| JournalError::Unavailable)?;
        if let Err(error) = result {
            if error
                .raw_response()
                .is_none_or(|response| response.status().as_u16() != 412)
            {
                return Err(JournalError::Unavailable);
            }
            let existing = self.read(&key).await?;
            if !existing.same_effect_as(record)? {
                return Err(JournalError::Conflict);
            }
        }
        Ok(())
    }

    async fn read(&self, key: &str) -> Result<JournalRecord, JournalError> {
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            self.client
                .get_object()
                .bucket(&self.bucket)
                .key(key)
                .send(),
        )
        .await
        .map_err(|_| JournalError::Unavailable)?
        .map_err(|_| JournalError::Unavailable)?;
        let bytes = tokio::time::timeout(Duration::from_secs(15), result.body.collect())
            .await
            .map_err(|_| JournalError::Unavailable)?
            .map_err(|_| JournalError::Unavailable)?
            .into_bytes();
        let value = serde_json::from_slice(&bytes).map_err(|_| JournalError::Shape)?;
        JournalRecord::verify(value, &self.signing_key)
    }

    async fn delete_pending(
        &self,
        source: &JournalSource,
        operation: &str,
    ) -> Result<(), JournalError> {
        tokio::time::timeout(
            Duration::from_secs(15),
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(Self::pending(source, operation)?)
                .send(),
        )
        .await
        .map_err(|_| JournalError::Unavailable)?
        .map_err(|_| JournalError::Unavailable)?;
        Ok(())
    }

    /// Source writes must have stopped. Missing/ambiguous outcomes fail closed;
    /// old completed records are outside the same one-hour restore buffer.
    pub async fn read_for_restore(
        &self,
        source: &JournalSource,
        captured_at: &str,
    ) -> Result<Vec<RecoveryEvent>, JournalError> {
        let captured = chrono::DateTime::parse_from_rfc3339(captured_at)
            .map_err(|_| JournalError::Shape)?
            .timestamp_millis();
        let prefix = format!("journal/operations/{}/", source.digest()?);
        let pending_prefix = format!("pending/operations/{}/", source.digest()?);
        let mut objects = BTreeMap::<String, i64>::new();
        for base in [&prefix, &pending_prefix] {
            let mut cursor = None;
            loop {
                let result = tokio::time::timeout(
                    Duration::from_secs(15),
                    self.client
                        .list_objects_v2()
                        .bucket(&self.bucket)
                        .prefix(base)
                        .set_continuation_token(cursor)
                        .send(),
                )
                .await
                .map_err(|_| JournalError::Unavailable)?
                .map_err(|_| JournalError::Unavailable)?;
                for object in result.contents() {
                    let key = object.key().ok_or(JournalError::Shape)?;
                    objects.insert(
                        key.into(),
                        object
                            .last_modified()
                            .and_then(|time| time.to_millis().ok())
                            .unwrap_or(i64::MAX),
                    );
                }
                if result.is_truncated() != Some(true) {
                    break;
                }
                cursor = Some(
                    result
                        .next_continuation_token()
                        .ok_or(JournalError::Shape)?
                        .to_owned(),
                );
            }
        }
        let mut operations = BTreeSet::new();
        for key in objects.keys() {
            let suffix = key
                .strip_prefix(&prefix)
                .or_else(|| key.strip_prefix(&pending_prefix))
                .ok_or(JournalError::Source)?;
            operations.insert(
                suffix
                    .split('/')
                    .next()
                    .ok_or(JournalError::Shape)?
                    .to_owned(),
            );
        }
        let mut events = Vec::new();
        for operation in operations {
            let id = uuid::Uuid::parse_str(&operation).map_err(|_| JournalError::Shape)?;
            if !id.hyphenated().to_string().eq_ignore_ascii_case(&operation) {
                return Err(JournalError::Shape);
            }
            let base = Self::prefix(source, &operation)?;
            let complete_key = format!("{base}completed.json");
            let abort_key = format!("{base}aborted.json");
            let pending = Self::pending(source, &operation)?;
            let prepared_key = if objects.contains_key(&pending) {
                pending
            } else {
                format!("{base}prepared.json")
            };
            let complete = objects.contains_key(&complete_key);
            let aborted = objects.contains_key(&abort_key);
            if complete && aborted {
                return Err(JournalError::Conflict);
            }
            if complete || aborted {
                let key = if complete { &complete_key } else { &abort_key };
                if objects[key] < captured.saturating_sub(3_600_000) {
                    continue;
                }
                let outcome = self.read(key).await?;
                if outcome.operation_id != operation
                    || &outcome.source != source
                    || outcome.kind
                        != if complete {
                            JournalKind::Completed
                        } else {
                            JournalKind::Aborted
                        }
                {
                    return Err(JournalError::Source);
                }
                if aborted {
                    continue;
                }
                for name in outcome.chunks.ok_or(JournalError::Shape)? {
                    let key = format!("{base}{name}");
                    if !objects.contains_key(&key) {
                        return Err(JournalError::Shape);
                    }
                    let chunk = self.read(&key).await?;
                    if chunk.kind != JournalKind::Chunk
                        || chunk.operation_id != operation
                        || &chunk.source != source
                    {
                        return Err(JournalError::Source);
                    }
                    events.extend(chunk.events.ok_or(JournalError::Shape)?);
                }
            } else if objects.contains_key(&prepared_key) {
                let prepared = self.read(&prepared_key).await?;
                if prepared.kind != JournalKind::Prepared
                    || prepared.operation_id != operation
                    || &prepared.source != source
                {
                    return Err(JournalError::Source);
                }
                return Err(JournalError::PublicationPending);
            } else if objects
                .iter()
                .filter(|(key, _)| key.starts_with(&base))
                .map(|(_, at)| *at)
                .max()
                .unwrap_or(i64::MAX)
                >= captured.saturating_sub(3_600_000)
            {
                return Err(JournalError::PublicationPending);
            }
        }
        events.sort_by_key(|event| event.sequence);
        Ok(events)
    }
}

#[async_trait]
impl DeletionJournalBackend for R2Journal {
    async fn prepare(
        &self,
        operation_id: &str,
        source: &JournalSource,
    ) -> Result<(), JournalError> {
        self.write(
            &Self::record(source, operation_id, JournalKind::Prepared),
            "prepared.json",
        )
        .await
    }
    async fn complete(
        &self,
        operation_id: &str,
        source: &JournalSource,
        mut events: EventBatches,
    ) -> Result<(), JournalError> {
        let mut chunks = Vec::new();
        while let Some(batch) = events.next().await {
            let name = format!("chunk-{}.json", chunks.len());
            let mut record = Self::record(source, operation_id, JournalKind::Chunk);
            record.events = Some(batch?);
            self.write(&record, &name).await?;
            chunks.push(name);
        }
        let mut record = Self::record(source, operation_id, JournalKind::Completed);
        record.chunks = Some(chunks);
        self.write(&record, "completed.json").await?;
        self.delete_pending(source, operation_id).await
    }
    async fn abort(&self, operation_id: &str, source: &JournalSource) -> Result<(), JournalError> {
        self.write(
            &Self::record(source, operation_id, JournalKind::Aborted),
            "aborted.json",
        )
        .await?;
        self.delete_pending(source, operation_id).await
    }
}
