use super::*;
use contract::providers::{Exchange, NativeCall, Tokens};
const FAILURE: &str = "Meeting sync failed. Check your connection and try again.";
#[derive(Clone, FromRow)]
struct Connection {
    id: Uuid,
    workspace_id: String,
    user_id: String,
    team_id: Uuid,
    provider: String,
    secret: Option<String>,
    oauth_state_hash: Option<String>,
    sync_lease_at: Option<DateTime<Utc>>,
}
struct Claim {
    connection: Connection,
    lease: DateTime<Utc>,
}
pub(super) async fn workspace(c: &mut PgConnection, id: &str) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::NotFound)?;
    Ok(())
}
async fn connection(c: &mut PgConnection, id: Uuid) -> Result<Option<Connection>, StoreError> {
    Ok(sqlx::query_as("SELECT id,workspace_id,user_id,team_id,provider,secret,oauth_state_hash,sync_lease_at FROM call_connections WHERE id=$1").bind(id).fetch_optional(c).await?)
}
async fn owner(
    c: &mut PgConnection,
    row: &Connection,
    requesting: Option<&Actor>,
) -> Result<(), StoreError> {
    let actor = if let Some(actor) = requesting {
        if actor.workspace_id != row.workspace_id || actor.user_id != row.user_id {
            return Err(StoreError::Forbidden);
        }
        current_actor(c, actor).await?
    } else {
        // A worker has no browser session. Resolve the stored owner's live
        // membership explicitly; this private actor is only a team-policy input.
        let role:String=sqlx::query_scalar("SELECT m.role FROM member m JOIN \"user\" u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 FOR SHARE OF m,u")
            .bind(&row.workspace_id).bind(&row.user_id).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
        Actor {
            user_id: row.user_id.clone(),
            workspace_id: row.workspace_id.clone(),
            workspace_role: role,
            authentication: forge_core::actor::Authentication::Session {
                session_id: "internal-meeting-sync".into(),
            },
            scopes: None,
            loop_scope: None,
        }
    };
    admin(&actor)?;
    policy::scope(&actor, ApiScope::TeamsRead)?;
    policy::team(c, &actor, row.team_id).await?;
    Ok(())
}
fn generation(row: &Connection, claim: &Claim) -> bool {
    let old = &claim.connection;
    row.id == old.id
        && row.workspace_id == old.workspace_id
        && row.user_id == old.user_id
        && row.team_id == old.team_id
        && row.provider == old.provider
        && row.secret == old.secret
        && row.oauth_state_hash == old.oauth_state_hash
}
impl Service {
    pub async fn sync(&self, actor: &Actor) -> Result<u64, StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        policy::scope(&actor, ApiScope::TeamsRead)?;
        let visible = policy::readable_team(&actor, "c.team_id");
        let ids:Vec<Uuid>=sqlx::query_scalar(&format!("SELECT c.id FROM call_connections c WHERE c.workspace_id=$1 AND c.user_id=$3 AND c.secret IS NOT NULL AND {visible} ORDER BY c.id"))
            .bind(&actor.workspace_id).bind(policy::privileged(&actor)).bind(&actor.user_id).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        let mut count = 0;
        for id in ids {
            count += self.sync_connection(id, Some(&actor)).await?;
        }
        Ok(count)
    }
    pub async fn sync_connection(
        &self,
        id: Uuid,
        requesting: Option<&Actor>,
    ) -> Result<u64, StoreError> {
        let Some(candidate):Option<Connection>=sqlx::query_as("SELECT id,workspace_id,user_id,team_id,provider,secret,oauth_state_hash,sync_lease_at FROM call_connections WHERE id=$1").bind(id).fetch_optional(self.database.pool()).await? else{return Ok(0);};
        let mut tx = self.database.begin().await?;
        workspace(&mut tx, &candidate.workspace_id).await?;
        let Some(row) = connection(&mut tx, id).await? else {
            tx.commit().await?;
            return Ok(0);
        };
        owner(&mut tx, &row, requesting).await?;
        let now = self.time();
        if row.secret.as_ref().is_none_or(String::is_empty)
            || row
                .sync_lease_at
                .is_some_and(|at| at >= now - chrono::Duration::minutes(15))
        {
            tx.commit().await?;
            return Ok(0);
        }
        tx.prepare().await?;
        sqlx::query("UPDATE call_connections SET sync_lease_at=$2 WHERE id=$1")
            .bind(id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let mut claim = Claim {
            connection: row,
            lease: now,
        };
        let result = self.sync_claim(&mut claim, requesting).await;
        if result.is_err() {
            self.release_sync(&claim).await?;
        }
        result
    }
    async fn checked_connection(
        &self,
        c: &mut PgConnection,
        claim: &Claim,
        requesting: Option<&Actor>,
    ) -> Result<Connection, StoreError> {
        workspace(c, &claim.connection.workspace_id).await?;
        let row = connection(c, claim.connection.id)
            .await?
            .ok_or(StoreError::NotFound)?;
        if !generation(&row, claim)
            || row.sync_lease_at != Some(claim.lease)
            || claim.lease < self.time() - chrono::Duration::minutes(15)
        {
            return Err(StoreError::Call(FAILURE));
        }
        owner(c, &row, requesting).await?;
        Ok(row)
    }
    async fn sync_claim(
        &self,
        claim: &mut Claim,
        requesting: Option<&Actor>,
    ) -> Result<u64, StoreError> {
        let gateway = self.gateway.as_ref().ok_or(StoreError::Call(FAILURE))?;
        let vault = self.vault.as_ref().ok_or(StoreError::Call(FAILURE))?;
        if !contract::selected_providers(&self.options.environment)
            .contains(&claim.connection.provider)
        {
            return Err(StoreError::Call(FAILURE));
        }
        // Recheck immediately before opening stored credentials. Network I/O is
        // outside SQL transactions; every subsequent publication checks again.
        let mut tx = self.database.begin().await?;
        self.checked_connection(&mut tx, claim, requesting).await?;
        let days = retention(&mut tx, &claim.connection.workspace_id).await?;
        tx.commit().await?;
        let context = format!(
            "meeting:{}:{}",
            claim.connection.workspace_id, claim.connection.id
        );
        let plaintext = vault
            .open(claim.connection.secret.as_deref().unwrap(), &context)
            .map_err(|_| StoreError::Call(FAILURE))?;
        let mut tokens: Tokens =
            serde_json::from_str(&plaintext).map_err(|_| StoreError::Call(FAILURE))?;
        if tokens.access_token.is_empty() || !tokens.expires_at.is_finite() {
            return Err(StoreError::Call(FAILURE));
        }
        if tokens.expires_at
            < (self.time() + chrono::Duration::minutes(1)).timestamp_millis() as f64
        {
            let refresh = tokens
                .refresh_token
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or(StoreError::Call(FAILURE))?;
            tokens = gateway
                .exchange(
                    &claim.connection.provider,
                    Exchange::Refresh {
                        refresh_token: refresh,
                    },
                )
                .await
                .map_err(|_| StoreError::Call(FAILURE))?;
            let secret = vault
                .seal(
                    &serde_json::to_string(&tokens).map_err(|_| StoreError::Call(FAILURE))?,
                    &context,
                )
                .map_err(|_| StoreError::Call(FAILURE))?;
            let mut tx = self.database.begin().await?;
            self.checked_connection(&mut tx, claim, requesting).await?;
            tx.prepare().await?;
            sqlx::query("UPDATE call_connections SET secret=$2 WHERE id=$1 AND sync_lease_at=$3")
                .bind(claim.connection.id)
                .bind(&secret)
                .bind(claim.lease)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            claim.connection.secret = Some(secret);
        }
        let since = self.time() - chrono::Duration::days(i64::from(days.min(7)));
        let records = gateway
            .native_calls(&claim.connection.provider, &tokens.access_token, since)
            .await
            .map_err(|_| StoreError::Call(FAILURE))?;
        let mut imported = 0;
        for record in records {
            if record.transcript.is_empty() || record.started_at < since {
                continue;
            }
            imported += self.import_native(claim, requesting, record).await?;
        }
        let mut tx = self.database.begin().await?;
        self.checked_connection(&mut tx, claim, requesting).await?;
        tx.prepare().await?;
        sqlx::query("UPDATE call_connections SET last_synced_at=$3,error=NULL,sync_lease_at=NULL WHERE id=$1 AND sync_lease_at=$2")
            .bind(claim.connection.id).bind(claim.lease).bind(self.time()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(imported)
    }
    async fn import_native(
        &self,
        claim: &Claim,
        requesting: Option<&Actor>,
        record: NativeCall,
    ) -> Result<u64, StoreError> {
        let mut tx = self.database.begin().await?;
        self.checked_connection(&mut tx, claim, requesting).await?;
        let days = retention(&mut tx, &claim.connection.workspace_id).await?;
        if record.started_at < self.time() - chrono::Duration::days(i64::from(days)) {
            tx.commit().await?;
            return Ok(0);
        }
        tx.prepare().await?;
        let count=sqlx::query("INSERT INTO calls(workspace_id,team_id,provider,external_id,title,started_at,duration,participants,transcript,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready') ON CONFLICT(workspace_id,provider,external_id) DO NOTHING")
            .bind(&claim.connection.workspace_id).bind(claim.connection.team_id).bind(&claim.connection.provider).bind(record.external_id).bind(record.title).bind(record.started_at).bind(record.duration).bind(json!(record.participants)).bind(contract::transcript_json(&record.transcript)).execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        Ok(count)
    }
    async fn release_sync(&self, claim: &Claim) -> Result<(), StoreError> {
        let mut tx = self.database.begin().await?;
        match workspace(&mut tx, &claim.connection.workspace_id).await {
            Ok(()) => {}
            Err(StoreError::NotFound) => {
                tx.commit().await?;
                return Ok(());
            }
            Err(error) => return Err(error),
        }
        let Some(row) = connection(&mut tx, claim.connection.id).await? else {
            tx.commit().await?;
            return Ok(());
        };
        if row.sync_lease_at != Some(claim.lease) {
            tx.commit().await?;
            return Ok(());
        }
        tx.prepare().await?;
        if generation(&row, claim) {
            sqlx::query("UPDATE call_connections SET error=$2 WHERE id=$1")
                .bind(row.id)
                .bind(FAILURE)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "UPDATE call_connections SET sync_lease_at=NULL WHERE id=$1 AND sync_lease_at=$2",
        )
        .bind(row.id)
        .bind(claim.lease)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
}
