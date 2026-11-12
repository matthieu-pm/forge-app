use super::*;
impl Service {
    pub async fn import(&self, actor: &Actor, value: Value) -> Result<Uuid, StoreError> {
        let value = input("import", value)?;
        let team = id(&value["teamId"])?;
        let parsed = DateTime::parse_from_rfc3339(value["startedAt"].as_str().unwrap())
            .map_err(|_| StoreError::InvalidInput)?;
        // JavaScript Date truncates its accepted fractional seconds to millis.
        let started = DateTime::from_timestamp_millis(parsed.timestamp_millis())
            .ok_or(StoreError::InvalidInput)?;
        let transcript = contract::parse_transcript(value["text"].as_str().unwrap());
        if transcript.is_empty()
            || transcript
                .iter()
                .any(|e| e.text.encode_utf16().count() > 20000)
        {
            return Err(StoreError::Call(
                "Upload a valid VTT, SRT, or speaker-labelled text transcript with shorter paragraphs.",
            ));
        }
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        policy::scope(&actor, ApiScope::TeamsRead)?;
        policy::team(&mut tx, &actor, team).await?;
        let days = retention(&mut tx, &actor.workspace_id).await?;
        let now = self.time();
        let cutoff = now
            .checked_sub_signed(chrono::Duration::days(i64::from(days)))
            .ok_or(StoreError::InvalidInput)?;
        if started < cutoff || started > now + chrono::Duration::days(1) {
            return Err(StoreError::Call(
                "Choose a past call within your workspace’s transcript retention period.",
            ));
        }
        let mut participants: Vec<&str> = vec![];
        for entry in &transcript {
            if !participants.contains(&entry.speaker.as_str()) {
                participants.push(&entry.speaker);
            }
        }
        let duration = (transcript.last().unwrap().seconds / 60.).ceil();
        if !duration.is_finite() || duration > f64::from(i32::MAX) {
            return Err(StoreError::InvalidInput);
        }
        tx.prepare().await?;
        let call = sqlx::query_scalar("INSERT INTO calls(workspace_id,team_id,provider,external_id,title,started_at,transcript,participants,duration,status) VALUES($1,$2,'upload',$3,$4,$5,$6,$7,$8,'ready') RETURNING id")
            .bind(&actor.workspace_id).bind(team).bind(Uuid::new_v4().to_string()).bind(value["title"].as_str().unwrap())
            .bind(started).bind(contract::transcript_json(&transcript)).bind(json!(participants)).bind(duration as i32).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(call)
    }
    pub async fn add_note(&self, actor: &Actor, value: Value) -> Result<(), StoreError> {
        let value = input("note", value)?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        let call = require_call(&mut tx, &actor, id(&value["callId"])?).await?;
        tx.prepare().await?;
        sqlx::query("INSERT INTO call_notes(call_id,user_id,body,kind) VALUES($1,$2,$3,$4)")
            .bind(call.id)
            .bind(&actor.user_id)
            .bind(value["body"].as_str().unwrap())
            .bind(value["kind"].as_str().unwrap())
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }
    pub async fn set_action(&self, actor: &Actor, value: Value) -> Result<(), StoreError> {
        let value = input("action", value)?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        let call = require_call(&mut tx, &actor, id(&value["callId"])?).await?;
        tx.prepare().await?;
        sqlx::query("UPDATE call_actions SET completed=$3 WHERE call_id=$1 AND id=$2")
            .bind(call.id)
            .bind(id(&value["actionId"])?)
            .bind(value["completed"].as_bool().unwrap())
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }
    pub async fn save_retention(&self, actor: &Actor, value: Value) -> Result<(), StoreError> {
        let value = input("retention", value)?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        admin(&actor)?;
        tx.prepare().await?;
        sqlx::query("INSERT INTO call_settings(workspace_id,retention_days) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET retention_days=EXCLUDED.retention_days")
            .bind(&actor.workspace_id).bind(value["days"].as_f64().unwrap() as i32).execute(&mut *tx).await?;
        sweep_in(&mut tx, &actor.workspace_id, self.time()).await?;
        tx.commit().await
    }
    pub async fn disconnect(&self, actor: &Actor, value: Value) -> Result<(), StoreError> {
        let value = input("disconnect", value)?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        admin(&actor)?;
        tx.prepare().await?;
        sqlx::query("DELETE FROM call_connections WHERE workspace_id=$1 AND id=$2")
            .bind(&actor.workspace_id)
            .bind(id(&value["id"])?)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }
}
