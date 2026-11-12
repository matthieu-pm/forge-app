//! Durable ownership for loop uploads. Source locks precede principal locks so
//! issue purge and publication share a consistent order. A cancelled future
//! leaves its upload reservation for the existing expiry sweeper.
use super::*;
use crate::agents::{Run, events};

async fn source_actor(
    c: &mut PgConnection,
    actor: &Actor,
    row: &metadata::Artifact,
) -> Result<Actor, StoreError> {
    let scope = actor.loop_scope.as_ref().ok_or(StoreError::Forbidden)?;
    let run: Uuid = scope.run_id.parse().map_err(|_| StoreError::Forbidden)?;
    let event: Value = sqlx::query_scalar(
        "SELECT event FROM loop_runs WHERE id=$1 AND workspace_id=$2 AND agent_run_id=$3",
    )
    .bind(run)
    .bind(&actor.workspace_id)
    .bind(row.run_id)
    .fetch_optional(&mut *c)
    .await?
    .ok_or(StoreError::Forbidden)?;
    if event["entity"] == "issue" {
        sqlx::query("SELECT id FROM issues WHERE workspace_id=$1 AND id::text=$2 AND deleted_at IS NULL AND purge_started_at IS NULL AND purged_at IS NULL FOR SHARE")
            .bind(&actor.workspace_id).bind(event["entityId"].as_str().unwrap_or_default()).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
    }
    let actor = live(c, actor, ApiScope::AgentsWrite).await?;
    if !crate::loops::agent_run_matches(c, &actor, row.run_id).await? {
        return Err(StoreError::Forbidden);
    }
    Ok(actor)
}
impl Service {
    pub(super) async fn create_loop_artifact(
        &self,
        actor: &Actor,
        owned: &Run,
        row: &metadata::Artifact,
        bytes: Vec<u8>,
    ) -> Result<Value, StoreError> {
        let result=async {
            let mut tx=self.database.begin().await?;
            let current=source_actor(&mut tx,actor,row).await?;
            let scope=current.loop_scope.as_ref().ok_or(StoreError::Forbidden)?;
            let loop_run:Uuid=scope.run_id.parse().map_err(|_|StoreError::Forbidden)?;
            tx.prepare().await?;
            sqlx::query("INSERT INTO loop_artifact_intents(id,workspace_id,loop_run_id,agent_run_id,storage_reference) VALUES($1,$2,$3,$4,$5)")
                .bind(row.id).bind(&current.workspace_id).bind(loop_run).bind(row.run_id).bind(&row.storage_reference).execute(&mut *tx).await?;
            tx.commit().await?;
            tokio::time::timeout(std::time::Duration::from_secs(60),self.blobs.put(&row.storage_reference,bytes)).await.map_err(|_|StoreError::Upload(forge_core::files::UploadError::Transport))??;
            let mut tx=self.database.begin().await?;
            let current=source_actor(&mut tx,actor,row).await?;
            sqlx::query("SELECT id FROM loop_artifact_intents WHERE id=$1 AND workspace_id=$2 AND loop_run_id=$3 AND agent_run_id=$4 AND storage_reference=$5 AND created_at+($6::bigint*interval '1 millisecond')>clock_timestamp() FOR UPDATE")
                .bind(row.id).bind(&current.workspace_id).bind(loop_run).bind(row.run_id).bind(&row.storage_reference).bind(forge_core::loops::ARTIFACT_INTENT_LEASE_MS).fetch_optional(&mut *tx).await?.ok_or(StoreError::Forbidden)?;
            publication_lock(&mut tx,row.id).await?;
            tx.prepare().await?;
            let saved=metadata::insert_artifact(&mut tx,row).await?;
            sqlx::query("DELETE FROM loop_artifact_intents WHERE id=$1 AND agent_run_id=$2 AND storage_reference=$3").bind(row.id).bind(row.run_id).bind(&row.storage_reference).execute(&mut *tx).await?;
            events::append_in(&mut tx,json!({"threadId":owned.thread_id,"runId":row.run_id,"sourceEventId":format!("artifact:{}",row.id),"occurredAt":iso(row.created_at),"source":"forge","type":"artifact.created","schemaVersion":1,"payload":saved.public()})).await?;
            tx.commit().await?;
            Ok::<_,StoreError>(saved.public())
        }.await;
        let Err(error) = result else {
            return result;
        };
        let recovered = self.recover_loop_artifact(row).await;
        match recovered {
            Ok(Some(saved)) => {
                // Confirming a SQL commit does not acknowledge an independent
                // journal publication that is known to have failed.
                if matches!(error, StoreError::Recovery(_)) {
                    return Err(error);
                }
                let mut tx = self.database.begin().await?;
                source_actor(&mut tx, actor, row).await?;
                tx.commit().await?;
                Ok(saved.public())
            }
            Ok(None) => {
                if self.blobs.delete(&row.storage_reference).await.is_ok() {
                    let _ = self.abandon_loop_artifact(row).await;
                }
                Err(error)
            }
            // Unknown ownership must never trigger compensation.
            Err(_) => Err(error),
        }
    }
    async fn recover_loop_artifact(
        &self,
        row: &metadata::Artifact,
    ) -> Result<Option<metadata::Artifact>, StoreError> {
        let mut tx = self.database.begin().await?;
        sqlx::query("SELECT id FROM loop_artifact_intents WHERE id=$1 AND agent_run_id=$2 AND storage_reference=$3 FOR UPDATE").bind(row.id).bind(row.run_id).bind(&row.storage_reference).fetch_optional(&mut *tx).await?;
        publication_lock(&mut tx, row.id).await?;
        let saved = sqlx::query_as(
            "SELECT * FROM agent_artifacts WHERE id=$1 AND run_id=$2 AND storage_reference=$3",
        )
        .bind(row.id)
        .bind(row.run_id)
        .bind(&row.storage_reference)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(saved)
    }
    async fn abandon_loop_artifact(&self, row: &metadata::Artifact) -> Result<(), StoreError> {
        let mut tx = self.database.begin().await?;
        tx.prepare().await?;
        sqlx::query("DELETE FROM loop_artifact_intents WHERE id=$1 AND agent_run_id=$2 AND storage_reference=$3").bind(row.id).bind(row.run_id).bind(&row.storage_reference).execute(&mut *tx).await?;
        tx.commit().await
    }
}
