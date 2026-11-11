use super::*;
use forge_core::canonical::command_input_hash;
fn limit(message: &'static str, seconds: u64) -> StoreError {
    UploadError::Limit {
        message,
        retry_after_seconds: Some(seconds),
    }
    .into()
}
impl UploadStore {
    pub async fn create(&self, a: &Actor, input: Value) -> Result<upload::Intent, StoreError> {
        let input = contract::upload_input(input).map_err(|_| StoreError::InvalidInput)?;
        let mut tx = self.database.begin().await?;
        let a = current_actor(&mut tx, a).await?;
        // Account admission spans workspaces. Lock account before workspace.
        for key in [
            format!("upload-account:{}", a.user_id),
            format!("upload-workspace:{}", a.workspace_id),
        ] {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
        fence(&mut tx, &a).await?;
        authorize_target(&mut tx, &a, &input["target"], self.agent_ui).await?;
        let hash = command_input_hash(&input);
        let existing:Option<Row>=sqlx::query_as("SELECT * FROM file_upload_intents WHERE workspace_id=$1 AND user_id=$2 AND command_key=$3")
            .bind(&a.workspace_id).bind(&a.user_id).bind(id(text(&input,"commandKey"))?).fetch_optional(&mut *tx).await?;
        if let Some(row) = existing {
            if row.input_hash != hash {
                return Err(UploadError::Conflict(
                    "This upload key was already used with different input.",
                )
                .into());
            }
            tx.commit().await?;
            return Ok(row.intent());
        }
        let now = (self.now)();
        let size = input["sizeBytes"]
            .as_i64()
            .ok_or(StoreError::InvalidInput)? as i32;
        tx.prepare().await?;
        assert_policy(&mut tx, &a, size, text(&input, "contentType"), now).await?;
        let (account_pending,workspace_pending,account_bytes,workspace_bytes):(i64,i64,i64,i64)=sqlx::query_as(
            "SELECT count(*) FILTER (WHERE state='pending' AND expires_at>$3 AND user_id=$1),count(*) FILTER (WHERE state='pending' AND expires_at>$3 AND workspace_id=$2),coalesce(sum(size_bytes) FILTER (WHERE user_id=$1),0)::bigint,coalesce(sum(size_bytes) FILTER (WHERE workspace_id=$2),0)::bigint FROM file_upload_intents WHERE (user_id=$1 OR workspace_id=$2) AND ((state='pending' AND expires_at>$3) OR (state='ready' AND completed_at>$4))")
            .bind(&a.user_id).bind(&a.workspace_id).bind(now).bind(now-Duration::hours(1)).fetch_one(&mut *tx).await?;
        if account_pending >= contract::ACCOUNT_PENDING
            || workspace_pending >= contract::WORKSPACE_PENDING
        {
            return Err(limit(
                "Too many unfinished uploads. Finish or cancel an upload before starting another.",
                60,
            ));
        }
        if account_bytes + i64::from(size) > contract::ACCOUNT_HOURLY_BYTES
            || workspace_bytes + i64::from(size) > contract::WORKSPACE_HOURLY_BYTES
        {
            return Err(limit(
                "The hourly upload byte allowance is reserved or used. Retry after capacity becomes available.",
                3600,
            ));
        }
        let row:Row=sqlx::query_as("INSERT INTO file_upload_intents(workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *")
            .bind(&a.workspace_id).bind(&a.user_id).bind(id(text(&input,"commandKey"))?).bind(hash).bind(&input["target"]).bind(text(&input,"name"))
            .bind(text(&input,"contentType")).bind(size).bind(text(&input,"checksum")).bind(format!("files/{}",Uuid::new_v4()))
            .bind(now).bind(now+Duration::milliseconds(contract::LIFETIME_MS)).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(row.intent())
    }
    pub async fn prepare(
        &self,
        a: &Actor,
        key: &str,
        issue_token: bool,
    ) -> Result<upload::Intent, StoreError> {
        let mut tx = self.database.begin().await?;
        let a = current_actor(&mut tx, a).await?;
        fence(&mut tx, &a).await?;
        let mut row = owned(&mut tx, &a, id(key)?).await?;
        authorize_target(&mut tx, &a, &row.target, self.agent_ui).await?;
        if row.state == "ready" {
            tx.commit().await?;
            return Ok(row.intent());
        }
        let now = (self.now)();
        row.pending(now)?;
        tx.prepare().await?;
        assert_policy(&mut tx, &a, row.size_bytes, &row.content_type, now).await?;
        if issue_token {
            let mut attempts: Vec<i64> = serde_json::from_value(row.attempts.clone())
                .map_err(|_| StoreError::InvalidInput)?;
            attempts.retain(|at| *at > now.timestamp_millis() - 3_600_000);
            if attempts.len() >= contract::ATTEMPTS_PER_HOUR {
                let seconds = (attempts[0] + 3_600_000 - now.timestamp_millis() + 999) / 1000;
                return Err(limit(
                    "This upload has reached five attempts in one hour. Retry later without extending its expiry.",
                    seconds.max(1) as u64,
                ));
            }
            attempts.push(now.timestamp_millis());
            let expiry = row
                .expires_at
                .min(now + Duration::milliseconds(contract::TOKEN_MS));
            row=sqlx::query_as("UPDATE file_upload_intents SET attempts=$1,token_expires_at=$2 WHERE id=$3 RETURNING *")
                .bind(json!(attempts)).bind(expiry).bind(row.id).fetch_one(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(row.intent())
    }
    pub async fn reject(&self, a: &Actor, key: &str, reason: &str) -> Result<(), StoreError> {
        // Ownership only: revocation must not prevent releasing a reservation.
        let mut tx = self.database.begin().await?;
        tx.prepare().await?;
        let reason = String::from_utf16_lossy(&reason.encode_utf16().take(500).collect::<Vec<_>>());
        sqlx::query("UPDATE file_upload_intents SET state='rejected',rejection_reason=$1 WHERE id=$2 AND workspace_id=$3 AND user_id=$4 AND state='pending'")
            .bind(reason).bind(id(key)?).bind(&a.workspace_id).bind(&a.user_id).execute(&mut *tx).await?;
        tx.commit().await
    }
    pub async fn cleanup_candidates(
        &self,
        before: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<upload::Intent>, StoreError> {
        let mut tx = self.database.begin().await?;
        tx.prepare().await?;
        sqlx::query("UPDATE file_upload_intents SET state='expired',rejection_reason='Upload expired.' WHERE state='pending' AND expires_at<=$1")
            .bind(before).execute(&mut *tx).await?;
        // Repeat deletion after one hour, to catch delayed writes using old tokens.
        let rows:Vec<Row>=sqlx::query_as("SELECT * FROM file_upload_intents WHERE state IN ('rejected','expired') AND (cleaned_at IS NULL OR cleaned_at<=$1) AND (token_expires_at IS NULL OR token_expires_at<=$2) ORDER BY cleaned_at ASC NULLS FIRST,created_at LIMIT $3")
            .bind(before-Duration::hours(1)).bind(before-Duration::minutes(15)).bind(limit.clamp(1,1000) as i64).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(rows.into_iter().map(Row::intent).collect())
    }
    pub async fn mark_cleaned(&self, key: &str) -> Result<(), StoreError> {
        let mut tx = self.database.begin().await?;
        tx.prepare().await?;
        sqlx::query("UPDATE file_upload_intents SET cleaned_at=$1 WHERE id=$2 AND state IN ('rejected','expired')")
            .bind((self.now)()).bind(id(key)?).execute(&mut *tx).await?;
        tx.commit().await
    }
}
