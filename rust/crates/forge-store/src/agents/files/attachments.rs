use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::{HashMap, HashSet};

impl Service {
    async fn upload_actor(&self, actor: &Actor, mime: &str) -> Result<Actor, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, ApiScope::AgentsWrite).await?;
        if !crate::security::settings(&mut tx, &actor.workspace_id)
            .await?
            .upload_allowed(mime)
        {
            return Err(StoreError::Forbidden);
        }
        tx.commit().await?;
        Ok(actor)
    }
    pub async fn upload_attachment(
        &self,
        actor: &Actor,
        input: Value,
    ) -> Result<Value, StoreError> {
        let actor = self.authorize(actor, ApiScope::AgentsWrite).await?;
        let input = contracts::attachment(input).map_err(|_| StoreError::InvalidInput)?;
        let actor = self
            .upload_actor(&actor, input["contentType"].as_str().unwrap())
            .await?;
        let bytes = policy::decode_attachment(input["contentBase64"].as_str().unwrap())?;
        if bytes.len() as u64 > self.settings.max_attachment_bytes {
            return Err(error(
                Code::AttachmentTooLarge,
                format!(
                    "Attachments cannot exceed {} bytes.",
                    self.settings.max_attachment_bytes
                ),
            ));
        }
        let id = Uuid::new_v4();
        let now = self.time();
        let row = metadata::Attachment {
            id,
            workspace_id: actor.workspace_id.clone(),
            user_id: actor.user_id.clone(),
            name: input["name"].as_str().unwrap().into(),
            content_type: input["contentType"].as_str().unwrap().into(),
            size_bytes: i32::try_from(bytes.len()).map_err(|_| StoreError::InvalidInput)?,
            storage_reference: format!("attachments/{id}"),
            checksum: checksum(&bytes),
            expires_at: expiry(now, self.settings.attachment_retention_hours, 3600)?,
            deleted_at: None,
            created_at: now,
        };
        self.blobs.put(&row.storage_reference, bytes).await?;
        let result = async {
            let mut tx = self.database.begin().await?;
            let actor = live(&mut tx, &actor, ApiScope::AgentsWrite).await?;
            if !crate::security::settings(&mut tx, &actor.workspace_id)
                .await?
                .upload_allowed(&row.content_type)
            {
                return Err(StoreError::Forbidden);
            }
            publication_lock(&mut tx, row.id).await?;
            tx.prepare().await?;
            let saved = metadata::insert_attachment(&mut tx, &row).await?;
            tx.commit().await?;
            Ok(saved.public())
        }
        .await;
        if result.is_err() {
            self.cleanup_unpublished("agent_attachments", row.id, &row.storage_reference)
                .await;
        }
        result
    }
    async fn attachment_records(
        &self,
        actor: &Actor,
        ids: &[Uuid],
    ) -> Result<Vec<metadata::Attachment>, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, ApiScope::AgentsWrite).await?;
        let rows = metadata::attachments(&mut tx, &actor, ids).await?;
        tx.commit().await?;
        let mut rows: HashMap<_, _> = rows.into_iter().map(|row| (row.id, row)).collect();
        let now = self.time();
        ids.iter()
            .map(|id| {
                rows.remove(id)
                    .filter(|row| row.deleted_at.is_none() && row.expires_at > now)
                    .ok_or_else(|| {
                        error(
                            Code::AttachmentNotFound,
                            "One or more attachments are unavailable or expired.",
                        )
                    })
            })
            .collect()
    }
    pub async fn resolve_attachments(
        &self,
        actor: &Actor,
        ids: &[Uuid],
    ) -> Result<Vec<Value>, StoreError> {
        let actor = self.authorize(actor, ApiScope::AgentsWrite).await?;
        if ids.len() > 20 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
            return Err(error(
                Code::InvalidAttachment,
                "A turn can contain at most 20 unique attachments.",
            ));
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let records = self.attachment_records(&actor, ids).await?;
        let size: u64 = records.iter().map(|r| r.size_bytes as u64).sum();
        if size > self.settings.max_turn_bytes {
            return Err(error(
                Code::AttachmentTooLarge,
                format!(
                    "Turn attachments cannot exceed {} bytes in total.",
                    self.settings.max_turn_bytes
                ),
            ));
        }
        let mut results = Vec::new();
        for record in records {
            let bytes = self
                .blobs
                .get(&record.storage_reference, forge_core::files::MAX_BYTES)
                .await?
                .ok_or_else(|| {
                    error(
                        Code::AttachmentNotFound,
                        "The attachment content is unavailable.",
                    )
                })?;
            if !matches(&bytes, record.size_bytes, &record.checksum) {
                return Err(error(
                    Code::InvalidAttachment,
                    "The attachment content failed its integrity check.",
                ));
            }
            let mut result = record.public();
            result["contentBase64"] = json!(STANDARD.encode(bytes));
            results.push(result);
        }
        // Do not release bytes after membership revocation, deletion or expiry
        // while storage I/O was pending.
        self.attachment_records(&actor, ids).await?;
        Ok(results)
    }
}
