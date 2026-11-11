use super::*;
use crate::agents::{capabilities::ArtifactCreator, events, runs};
use forge_core::agents::tokens::{self, Kind};

async fn owned_run(
    connection: &mut PgConnection,
    actor: &Actor,
    run: Uuid,
) -> Result<crate::agents::Run, StoreError> {
    runs::get_in(connection, &actor.workspace_id, run)
        .await?
        .filter(|row| {
            row.initiated_by_user_id == actor.user_id
                && match &actor.authentication {
                    Authentication::Agent { run_id, .. } => {
                        run_id.parse::<Uuid>().ok() == Some(run)
                    }
                    _ => true,
                }
        })
        .ok_or_else(|| error(Code::ArtifactNotFound, "The agent run was not found."))
}
impl Service {
    pub async fn create_artifact(
        &self,
        actor: &Actor,
        run: Uuid,
        input: Value,
    ) -> Result<Value, StoreError> {
        let actor = self.authorize(actor, ApiScope::AgentsWrite).await?;
        let input = contracts::artifact(input).map_err(|_| StoreError::InvalidInput)?;
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, &actor, ApiScope::AgentsWrite).await?;
        let owned = owned_run(&mut tx, &actor, run).await?;
        let bytes = policy::decode_artifact(
            input["content"].as_str().unwrap(),
            input["encoding"] == "base64",
        );
        if bytes.len() as u64 > self.settings.max_artifact_bytes {
            return Err(error(
                Code::ArtifactTooLarge,
                format!(
                    "Artifacts cannot exceed {} bytes.",
                    self.settings.max_artifact_bytes
                ),
            ));
        }
        let hash = checksum(&bytes);
        let name = input["name"].as_str().unwrap();
        if let Some(existing) = metadata::existing_artifact(&mut tx, run, &hash, name)
            .await?
            .filter(|r| r.deleted_at.is_none())
        {
            tx.commit().await?;
            return Ok(existing.public());
        }
        tx.commit().await?;
        let id = Uuid::new_v4();
        let now = self.time();
        let row = metadata::Artifact {
            id,
            run_id: run,
            kind: input["kind"].as_str().unwrap().into(),
            name: name.into(),
            content_type: input["contentType"].as_str().unwrap().into(),
            size_bytes: i32::try_from(bytes.len()).map_err(|_| StoreError::InvalidInput)?,
            storage_reference: format!("{run}/{id}"),
            checksum: hash,
            retention_expires_at: Some(expiry(now, self.settings.artifact_retention_days, 86_400)?),
            deleted_at: None,
            created_at: now,
        };
        // current_actor denies linked loop principals until the loop milestone
        // supplies source-fenced publication and durable upload reservations.
        self.blobs.put(&row.storage_reference, bytes).await?;
        let result=async {
            let mut tx=self.database.begin().await?;let actor=live(&mut tx,&actor,ApiScope::AgentsWrite).await?;
            owned_run(&mut tx,&actor,run).await?;publication_lock(&mut tx,id).await?;tx.prepare().await?;
            let saved=metadata::insert_artifact(&mut tx,&row).await?;
            events::append_in(&mut tx,json!({"threadId":owned.thread_id,"runId":run,"sourceEventId":format!("artifact:{id}"),"occurredAt":iso(now),"source":"forge","type":"artifact.created","schemaVersion":1,"payload":saved.public()})).await?;
            tx.commit().await?;Ok(saved.public())
        }.await;
        if result.is_err() {
            self.cleanup_unpublished("agent_artifacts", id, &row.storage_reference)
                .await;
        }
        result
    }
    async fn artifact_record(
        &self,
        actor: &Actor,
        id: Uuid,
    ) -> Result<metadata::Artifact, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, ApiScope::AgentsRead).await?;
        let row = metadata::artifact(&mut tx, &actor, id, self.time()).await?;
        tx.commit().await?;
        Ok(row)
    }
    pub async fn artifact_metadata(&self, actor: &Actor, id: Uuid) -> Result<Value, StoreError> {
        Ok(self.artifact_record(actor, id).await?.public())
    }
    pub async fn artifact_download(
        &self,
        actor: &Actor,
        id: Uuid,
        secret: &str,
    ) -> Result<Value, StoreError> {
        let artifact = self.artifact_metadata(actor, id).await?;
        let token = tokens::mint(
            secret,
            Kind::Artifact,
            json!({"sub":actor.user_id,"workspaceId":actor.workspace_id,"artifactId":id}),
            self.time().timestamp(),
            300.,
        )
        .map_err(|_| StoreError::InvalidInput)?;
        Ok(
            json!({"artifact":artifact,"downloadUrl":format!("/api/agent/artifacts/{id}/content?token={token}"),"expiresInSeconds":300}),
        )
    }
    pub async fn read_artifact(
        &self,
        actor: &Actor,
        id: Uuid,
    ) -> Result<(Value, Vec<u8>), StoreError> {
        let row = self.artifact_record(actor, id).await?;
        if row.size_bytes > 100_000_000 {
            return Err(error(
                Code::ArtifactTooLarge,
                "The artifact exceeds the delivery limit.",
            ));
        }
        let bytes = self
            .blobs
            .get(&row.storage_reference, row.size_bytes as usize)
            .await?
            .ok_or_else(|| {
                error(
                    Code::ArtifactNotFound,
                    "The artifact content is unavailable.",
                )
            })?;
        if !matches(&bytes, row.size_bytes, &row.checksum) {
            return Err(error(
                Code::InvalidArtifactContent,
                "The artifact content failed its integrity check.",
            ));
        }
        self.artifact_record(actor, id).await?;
        Ok((row.public(), bytes))
    }
}
#[async_trait::async_trait]
impl ArtifactCreator for Service {
    async fn create(&self, actor: &Actor, run: Uuid, input: Value) -> Result<Value, StoreError> {
        self.create_artifact(actor, run, input).await
    }
}
