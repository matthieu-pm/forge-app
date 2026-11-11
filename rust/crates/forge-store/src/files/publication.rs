use super::*;
use crate::commands::{self, Command, CommandHandler, CommandResult, OutboxEvent};
use serde::{Deserialize, Deserializer, Serialize};
#[derive(Serialize)]
#[serde(transparent)]
struct Ready(Value);
impl<'de> Deserialize<'de> for Ready {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        contract::ready_upload(Value::deserialize(d)?)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}
struct Publish<'a> {
    store: &'a UploadStore,
    key: Uuid,
    verified: Value,
}
#[async_trait::async_trait]
impl CommandHandler for Publish<'_> {
    type Output = Ready;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Ready>,
    ) -> Result<(), StoreError> {
        fence(c, a).await?;
        let row = owned(c, a, self.key).await?;
        authorize_target(c, a, &row.target, self.store.agent_ui).await
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Ready>, StoreError> {
        let row = owned(c, a, self.key).await?;
        if row.result.is_some() {
            return Err(
                UploadError::Conflict("Ready upload is missing its command receipt.").into(),
            );
        }
        let now = (self.store.now)();
        row.pending(now)?;
        if self.verified["checksum"] != row.checksum
            || self.verified["sizeBytes"].as_i64() != Some(i64::from(row.size_bytes))
        {
            return Err(invalid("The stored file does not match the upload intent."));
        }
        let mime = self.verified["contentType"]
            .as_str()
            .ok_or(StoreError::InvalidInput)?;
        assert_policy(c, a, row.size_bytes, mime, now).await?;
        let agent = row.target["kind"] == "agent";
        let expiry = agent.then_some(now + Duration::hours(24));
        let result=contract::ready_upload(json!({"id":row.id,"name":row.name,"contentType":mime,"sizeBytes":row.size_bytes,"checksum":row.checksum,"createdAt":iso(now),"expiresAt":expiry.map(iso)}))
            .map_err(|_|StoreError::InvalidInput)?;
        if agent {
            if !matches!(
                mime,
                "application/json"
                    | "application/pdf"
                    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    | "image/gif"
                    | "image/jpeg"
                    | "image/png"
                    | "image/webp"
                    | "text/csv"
                    | "text/markdown"
                    | "text/plain"
            ) {
                return Err(invalid(
                    "This file format is not supported by the agent composer.",
                ));
            }
            sqlx::query("INSERT INTO agent_attachments(id,workspace_id,user_id,name,content_type,size_bytes,checksum,storage_reference,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
                .bind(row.id).bind(&a.workspace_id).bind(&a.user_id).bind(&row.name).bind(mime).bind(row.size_bytes).bind(&row.checksum).bind(&row.storage_reference).bind(now).bind(expiry).execute(&mut *c).await?;
        } else {
            let kind = text(&row.target, "kind");
            let target = id(text(&row.target, "id"))?;
            sqlx::query("INSERT INTO resource_files(id,workspace_id,created_by_user_id,name,content_type,size_bytes,checksum,storage_reference,created_at,issue_id,document_id,project_id,attachment_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
                .bind(row.id).bind(&a.workspace_id).bind(&a.user_id).bind(&row.name).bind(mime).bind(row.size_bytes).bind(&row.checksum).bind(&row.storage_reference).bind(now)
                .bind((kind=="issue").then_some(target)).bind((kind=="document").then_some(target)).bind((kind=="project").then_some(target))
                .bind(matches!(kind,"issue"|"project").then_some("unbound")).execute(&mut *c).await?;
        }
        sqlx::query(
            "UPDATE file_upload_intents SET state='ready',result=$1,completed_at=$2 WHERE id=$3",
        )
        .bind(&result)
        .bind(now)
        .bind(row.id)
        .execute(&mut *c)
        .await?;
        Ok(CommandResult {
            value: Ready(result),
            resource_type: "file".into(),
            resource_id: row.id.to_string(),
            events: vec![OutboxEvent {
                topic: "file.ready".into(),
                payload: json!({"fileId":row.id,"target":row.target})
                    .as_object()
                    .unwrap()
                    .clone(),
            }],
        })
    }
}
impl UploadStore {
    pub async fn publish(
        &self,
        a: &Actor,
        key: &str,
        verified: Value,
    ) -> Result<Value, StoreError> {
        let key = id(key)?;
        let key_text = key.to_string();
        let input = json!({"id":key});
        let result = commands::execute(
            &self.database,
            a,
            Command {
                key: &key_text,
                operation: "files.upload.finalize",
                input: &input,
                status: 201,
            },
            &Publish {
                store: self,
                key,
                verified,
            },
        )
        .await?;
        Ok(result.value.0)
    }
}
