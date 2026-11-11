use super::*;
use serde::Serialize;

#[derive(Default, Debug, Serialize)]
pub struct Sweep {
    pub examined: usize,
    pub deleted: usize,
    pub failures: Vec<Value>,
}
#[derive(sqlx::FromRow)]
struct Reservation {
    id: Uuid,
    agent_run_id: Uuid,
    storage_reference: String,
}
impl Service {
    pub async fn sweep_attachments(
        &self,
        before: DateTime<Utc>,
        limit: usize,
    ) -> Result<Sweep, StoreError> {
        let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM agent_attachments WHERE deleted_at IS NULL AND expires_at<=$1 ORDER BY expires_at LIMIT $2").bind(before).bind(limit.clamp(1,1000) as i64).fetch_all(self.database.pool()).await?;
        let mut report = Sweep {
            examined: ids.len(),
            ..Default::default()
        };
        for id in ids {
            let result=async {
                let mut tx=self.database.begin().await?;
                let row:Option<metadata::Attachment>=sqlx::query_as("SELECT * FROM agent_attachments WHERE id=$1 AND deleted_at IS NULL AND expires_at<=$2 FOR UPDATE").bind(id).bind(before).fetch_optional(&mut *tx).await?;
                let Some(row)=row else{tx.commit().await?;return Ok(false);};
                tx.prepare().await?;self.blobs.delete(&row.storage_reference).await?;
                sqlx::query("UPDATE agent_attachments SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL").bind(id).bind(before).execute(&mut *tx).await?;
                tx.commit().await?;Ok::<_,StoreError>(true)
            }.await;
            match result {
                Ok(true) => report.deleted += 1,
                Ok(false) => {}
                Err(_) => report
                    .failures
                    .push(json!({"attachmentId":id,"message":"Attachment retention failed."})),
            }
        }
        Ok(report)
    }
    pub async fn sweep_artifacts(
        &self,
        before: DateTime<Utc>,
        limit: usize,
    ) -> Result<Sweep, StoreError> {
        let limit = limit.clamp(1, 1000) as i64;
        let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM agent_artifacts WHERE deleted_at IS NULL AND retention_expires_at<=$1 ORDER BY retention_expires_at LIMIT $2").bind(before).bind(limit).fetch_all(self.database.pool()).await?;
        let mut report = self.sweep_reservations(before, limit).await?;
        report.examined += ids.len();
        for id in ids {
            let result=async {
                let mut tx=self.database.begin().await?;
                let row:Option<metadata::Artifact>=sqlx::query_as("SELECT * FROM agent_artifacts WHERE id=$1 AND deleted_at IS NULL AND retention_expires_at<=$2 FOR UPDATE").bind(id).bind(before).fetch_optional(&mut *tx).await?;
                let Some(row)=row else{tx.commit().await?;return Ok(false);};
                tx.prepare().await?;self.blobs.delete(&row.storage_reference).await?;
                sqlx::query("UPDATE agent_artifacts SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL").bind(id).bind(before).execute(&mut *tx).await?;
                tx.commit().await?;Ok::<_,StoreError>(true)
            }.await;
            match result {
                Ok(true) => report.deleted += 1,
                Ok(false) => {}
                Err(_) => report
                    .failures
                    .push(json!({"artifactId":id,"message":"Artifact retention failed."})),
            }
        }
        Ok(report)
    }
    async fn sweep_reservations(
        &self,
        before: DateTime<Utc>,
        limit: i64,
    ) -> Result<Sweep, StoreError> {
        let cutoff = before - Duration::minutes(20);
        let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM loop_artifact_intents WHERE created_at<=$1 ORDER BY created_at LIMIT $2").bind(cutoff).bind(limit).fetch_all(self.database.pool()).await?;
        let mut report = Sweep {
            examined: ids.len(),
            ..Default::default()
        };
        for id in ids {
            let result=async {
                let mut tx=self.database.begin().await?;
                let row:Option<Reservation>=sqlx::query_as("SELECT id,agent_run_id,storage_reference FROM loop_artifact_intents WHERE id=$1 AND created_at<=$2 FOR UPDATE").bind(id).bind(cutoff).fetch_optional(&mut *tx).await?;
                let Some(row)=row else{tx.commit().await?;return Ok(false);};
                let published:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_artifacts WHERE id=$1 AND run_id=$2 AND storage_reference=$3)").bind(row.id).bind(row.agent_run_id).bind(&row.storage_reference).fetch_one(&mut *tx).await?;
                tx.prepare().await?;
                if !published{self.blobs.delete(&row.storage_reference).await?;}
                sqlx::query("DELETE FROM loop_artifact_intents WHERE id=$1").bind(row.id).execute(&mut *tx).await?;
                tx.commit().await?;Ok::<_,StoreError>(!published)
            }.await;
            match result {
                Ok(true) => report.deleted += 1,
                Ok(false) => {}
                Err(_) => report.failures.push(
                    json!({"artifactId":id,"message":"Loop artifact upload cleanup failed."}),
                ),
            }
        }
        Ok(report)
    }
}
