use super::*;
const FAILURE: &str =
    "The summary could not be generated. Your transcript is saved; try again shortly.";
async fn authorized(
    c: &mut PgConnection,
    workspace: &str,
    call: Uuid,
    requesting: Option<&Actor>,
) -> Result<Option<Call>, StoreError> {
    sync::workspace(c, workspace).await?;
    if let Some(actor) = requesting {
        if actor.workspace_id != workspace {
            return Err(StoreError::NotFound);
        }
        let actor = current_actor(c, actor).await?;
        return require_call(c, &actor, call).await.map(Some);
    }
    // The operator owns a system summary operation, not an impersonated user.
    // Archived teams are deliberately excluded, even for private team calls.
    let team: Option<Uuid> = sqlx::query_scalar("SELECT t.id FROM teams t JOIN calls c ON c.team_id=t.id AND c.workspace_id=t.workspace_id WHERE c.id=$1 AND c.workspace_id=$2 AND t.deleted_at IS NULL FOR SHARE OF t")
        .bind(call).bind(workspace).fetch_optional(&mut *c).await?;
    if team.is_none() {
        return Ok(None);
    }
    Ok(
        sqlx::query_as("SELECT * FROM calls WHERE id=$1 AND workspace_id=$2 FOR UPDATE")
            .bind(call)
            .bind(workspace)
            .fetch_optional(c)
            .await?,
    )
}
impl Service {
    pub async fn summary(&self, actor: &Actor, value: Value) -> Result<(), StoreError> {
        let value = input("read", value)?;
        self.summarize_call(id(&value["callId"])?, Some(actor))
            .await?;
        Ok(())
    }
    pub async fn summarize_call(
        &self,
        id: Uuid,
        requesting: Option<&Actor>,
    ) -> Result<bool, StoreError> {
        let workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace_id FROM calls WHERE id=$1")
                .bind(id)
                .fetch_optional(self.database.pool())
                .await?;
        let Some(workspace) = workspace else {
            return if requesting.is_some() {
                Err(StoreError::NotFound)
            } else {
                Ok(false)
            };
        };
        let mut tx = self.database.begin().await?;
        let Some(mut call) = authorized(&mut tx, &workspace, id, requesting).await? else {
            tx.commit().await?;
            return Ok(false);
        };
        let now = self.time();
        tx.prepare().await?;
        sweep_in(&mut tx, &workspace, now).await?;
        if call.started_at
            < now - chrono::Duration::days(i64::from(retention(&mut tx, &workspace).await?))
        {
            call.status = "expired".into();
        }
        if call.status != "ready"
            || !["pending", "error"].contains(&call.summary_status.as_str())
            || call
                .summary_lease_at
                .is_some_and(|at| at >= now - chrono::Duration::minutes(10))
        {
            tx.commit().await?;
            return Ok(false);
        }
        sqlx::query("UPDATE calls SET summary_lease_at=$2 WHERE id=$1")
            .bind(id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        // A durable claim must be independently acknowledged before model I/O.
        tx.commit().await?;
        let result = self.summary_claim(&call, now, requesting).await;
        if result.is_err() {
            self.release_summary(&workspace, id, now).await?;
        }
        result
    }
    async fn summary_claim(
        &self,
        call: &Call,
        lease: DateTime<Utc>,
        requesting: Option<&Actor>,
    ) -> Result<bool, StoreError> {
        let transcript: Vec<contract::TranscriptEntry> =
            serde_json::from_value(call.transcript.clone())
                .map_err(|_| StoreError::Call(FAILURE))?;
        let text = transcript
            .iter()
            .map(|e| format!("{}: {}", e.speaker, e.text))
            .collect::<Vec<_>>()
            .join("\n");
        if text.encode_utf16().count() > 250000 {
            return Err(StoreError::Call(FAILURE));
        }
        let recap = self
            .summarizer
            .as_ref()
            .ok_or(StoreError::Call(FAILURE))?
            .summarize(&text)
            .await
            .map_err(|_| StoreError::Call(FAILURE))?;
        let recap = contract::input("recap", recap).map_err(|_| StoreError::Call(FAILURE))?;
        let mut tx = self.database.begin().await?;
        let Some(current) = authorized(&mut tx, &call.workspace_id, call.id, requesting).await?
        else {
            return Err(StoreError::Call(FAILURE));
        };
        if current.summary_lease_at != Some(lease)
            || lease < self.time() - chrono::Duration::minutes(10)
        {
            return Err(StoreError::Call(FAILURE));
        }
        tx.prepare().await?;
        sweep_in(&mut tx, &call.workspace_id, self.time()).await?;
        let changed = sqlx::query("UPDATE calls SET summary=$3,decisions=$4,summary_status='ready',summary_lease_at=NULL WHERE id=$1 AND summary_lease_at=$2 AND status='ready' AND summary_status IN ('pending','error')")
            .bind(call.id).bind(lease).bind(recap["summary"].as_str().unwrap()).bind(&recap["decisions"]).execute(&mut *tx).await?.rows_affected();
        if changed > 0 {
            for action in recap["actions"].as_array().unwrap() {
                sqlx::query("INSERT INTO call_actions(call_id,title,owner) VALUES($1,$2,$3)")
                    .bind(call.id)
                    .bind(action["title"].as_str().unwrap())
                    .bind(action["owner"].as_str().unwrap())
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        Ok(changed > 0)
    }
    async fn release_summary(
        &self,
        workspace: &str,
        id: Uuid,
        lease: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        let mut tx = self.database.begin().await?;
        match sync::workspace(&mut tx, workspace).await {
            Ok(()) => {}
            Err(StoreError::NotFound) => {
                tx.commit().await?;
                return Ok(());
            }
            Err(error) => return Err(error),
        }
        // Cleanup does not require a still-authorized requester, but can only
        // release this exact generation; it cannot alter a successor's work.
        tx.prepare().await?;
        sqlx::query("UPDATE calls SET summary_status='error',summary_lease_at=NULL WHERE id=$1 AND workspace_id=$2 AND summary_lease_at=$3")
            .bind(id).bind(workspace).bind(lease).execute(&mut *tx).await?;
        tx.commit().await
    }
}
