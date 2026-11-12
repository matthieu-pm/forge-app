use super::*;
impl Service {
    pub async fn list(&self, actor: &Actor, value: Value) -> Result<Value, StoreError> {
        let value = input("list", value)?;
        let team = value.get("teamId").map(id).transpose()?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        policy::scope(&actor, ApiScope::TeamsRead)?;
        if let Some(team) = team {
            policy::team(&mut tx, &actor, team).await?;
        }
        tx.prepare().await?;
        sweep_in(&mut tx, &actor.workspace_id, self.time()).await?;
        let visible = policy::readable_team(&actor, "c.team_id");
        let rows: Vec<Call> = sqlx::query_as(&format!("SELECT c.id,c.workspace_id,c.team_id,c.provider,c.external_id,c.title,c.started_at,c.duration,c.participants,'[]'::jsonb transcript,c.summary,c.decisions,c.status,c.summary_status,c.summary_lease_at FROM calls c WHERE c.workspace_id=$1 AND {visible} AND ($4::uuid IS NULL OR c.team_id=$4) ORDER BY c.started_at DESC,c.id LIMIT 100"))
            .bind(&actor.workspace_id).bind(policy::privileged(&actor)).bind(&actor.user_id).bind(team).fetch_all(&mut *tx).await?;
        let records = decorate(&mut tx, &rows).await?;
        let connections: Vec<Value> = sqlx::query_scalar(&format!("SELECT jsonb_build_object('id',c.id,'teamId',c.team_id,'provider',c.provider,'connected',c.secret IS NOT NULL AND c.secret<>'','lastSyncedAt',CASE WHEN c.last_synced_at IS NULL THEN NULL ELSE to_char(c.last_synced_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END,'error',c.error,'isOwner',c.user_id=$3) FROM call_connections c WHERE c.workspace_id=$1 AND {visible} ORDER BY c.id"))
            .bind(&actor.workspace_id).bind(policy::privileged(&actor)).bind(&actor.user_id).fetch_all(&mut *tx).await?;
        let days = retention(&mut tx, &actor.workspace_id).await?;
        tx.commit().await?;
        Ok(
            json!({"calls":records,"connections":connections,"canManage":policy::privileged(&actor),
            "retentionDays":days,"configuredProviders":contract::configured_providers(&self.options.environment)}),
        )
    }
    pub async fn read(&self, actor: &Actor, value: Value) -> Result<Value, StoreError> {
        let value = input("read", value)?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        // Scope is established before any redaction; a forbidden target cannot
        // disclose a call through its projection or consume a mutation result.
        require_call(&mut tx, &actor, id(&value["callId"])?).await?;
        tx.prepare().await?;
        sweep_in(&mut tx, &actor.workspace_id, self.time()).await?;
        let row = require_call(&mut tx, &actor, id(&value["callId"])?).await?;
        let mut records = decorate(&mut tx, &[row]).await?;
        tx.commit().await?;
        Ok(records.remove(0))
    }
}
