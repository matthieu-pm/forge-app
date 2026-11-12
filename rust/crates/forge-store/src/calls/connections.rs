use super::*;
use contract::providers::Exchange;
use sha2::{Digest, Sha256};
fn expired() -> StoreError {
    StoreError::Call("This meeting connection request has expired. Try again.")
}
#[derive(FromRow)]
struct Pending {
    id: Uuid,
    team_id: Uuid,
    provider: String,
    oauth_verifier: Option<String>,
    oauth_expires_at: Option<DateTime<Utc>>,
}
impl Service {
    pub async fn begin_connection(
        &self,
        actor: &Actor,
        value: Value,
    ) -> Result<String, StoreError> {
        let value = input("connect", value)?;
        let provider = value["provider"].as_str().unwrap();
        let team = id(&value["teamId"])?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        admin(&actor)?;
        policy::scope(&actor, ApiScope::TeamsRead)?;
        policy::team(&mut tx, &actor, team).await?;
        if !contract::configured_providers(&self.options.environment)
            .iter()
            .any(|p| p == provider)
            || self.vault.is_none()
        {
            return Err(StoreError::Call(
                "Your Forge administrator needs to configure this provider’s OAuth app first.",
            ));
        }
        let gateway = self
            .gateway
            .as_ref()
            .ok_or(StoreError::Call("Meeting connections are not configured."))?;
        let state = forge_identity::random_token(32);
        let verifier = forge_identity::random_token(32);
        let url = gateway
            .authorization_url(provider, &state, &forge_identity::pkce_challenge(&verifier))
            .map_err(|_| {
                StoreError::Call("This meeting provider is unavailable for this deployment.")
            })?;
        let hash = format!("{:x}", Sha256::digest(state.as_bytes()));
        let expires = self.time() + chrono::Duration::minutes(10);
        tx.prepare().await?;
        sqlx::query("INSERT INTO call_connections(workspace_id,user_id,team_id,provider,oauth_state_hash,oauth_verifier,oauth_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,user_id,provider) DO UPDATE SET team_id=EXCLUDED.team_id,oauth_state_hash=EXCLUDED.oauth_state_hash,oauth_verifier=EXCLUDED.oauth_verifier,oauth_expires_at=EXCLUDED.oauth_expires_at")
            .bind(&actor.workspace_id).bind(&actor.user_id).bind(team).bind(provider).bind(hash).bind(verifier).bind(expires).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(url)
    }
    pub async fn finish_connection(
        &self,
        actor: &Actor,
        state: &str,
        code: &str,
    ) -> Result<(), StoreError> {
        if state.is_empty()
            || code.is_empty()
            || state.encode_utf16().count() > 256
            || code.encode_utf16().count() > 4096
        {
            return Err(expired());
        }
        let gateway = self
            .gateway
            .as_ref()
            .ok_or(StoreError::Call("Meeting connections are not configured."))?;
        let vault = self
            .vault
            .as_ref()
            .ok_or(StoreError::Call("Meeting credentials are not configured."))?;
        let hash = format!("{:x}", Sha256::digest(state.as_bytes()));
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, actor).await?;
        admin(&actor)?;
        policy::scope(&actor, ApiScope::TeamsRead)?;
        let row:Pending=sqlx::query_as("SELECT id,team_id,provider,oauth_verifier,oauth_expires_at FROM call_connections WHERE workspace_id=$1 AND user_id=$2 AND oauth_state_hash=$3")
            .bind(&actor.workspace_id).bind(&actor.user_id).bind(&hash).fetch_optional(&mut *tx).await?.ok_or_else(expired)?;
        if row.oauth_expires_at.is_none_or(|at| at < self.time())
            || row.oauth_verifier.as_ref().is_none_or(String::is_empty)
        {
            return Err(expired());
        }
        policy::team(&mut tx, &actor, row.team_id).await?;
        // Null expiry/verifier consume the request. Retaining only its hash
        // fences publication against a newer begin, disconnect or callback.
        tx.prepare().await?;
        let claimed=sqlx::query("UPDATE call_connections SET oauth_expires_at=NULL,oauth_verifier=NULL WHERE id=$1 AND oauth_state_hash=$2 AND oauth_expires_at IS NOT NULL")
            .bind(row.id).bind(&hash).execute(&mut *tx).await?.rows_affected();
        if claimed != 1 {
            return Err(expired());
        }
        tx.commit().await?;
        let tokens = gateway
            .exchange(
                &row.provider,
                Exchange::Code {
                    code,
                    verifier: row.oauth_verifier.as_deref().unwrap(),
                },
            )
            .await
            .map_err(|_| {
                StoreError::Call(
                    "Meeting authorization expired or was denied. Reconnect your account.",
                )
            })?;
        let secret = vault
            .seal(
                &serde_json::to_string(&tokens).map_err(|_| StoreError::InvalidInput)?,
                &format!("meeting:{}:{}", actor.workspace_id, row.id),
            )
            .map_err(|_| StoreError::Call("The meeting credential vault is unavailable."))?;
        let mut tx = self.database.begin().await?;
        let actor = scope(&mut tx, &actor).await?;
        admin(&actor)?;
        policy::scope(&actor, ApiScope::TeamsRead)?;
        policy::team(&mut tx, &actor, row.team_id).await?;
        tx.prepare().await?;
        let saved=sqlx::query("UPDATE call_connections SET secret=$7,error=NULL,oauth_state_hash=NULL WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND team_id=$4 AND provider=$5 AND oauth_state_hash=$6 AND oauth_expires_at IS NULL AND oauth_verifier IS NULL")
            .bind(row.id).bind(&actor.workspace_id).bind(&actor.user_id).bind(row.team_id).bind(&row.provider).bind(&hash).bind(secret).execute(&mut *tx).await?.rows_affected();
        if saved != 1 {
            return Err(expired());
        }
        tx.commit().await
    }
}
