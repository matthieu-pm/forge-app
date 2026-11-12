use super::*;
use forge_core::{
    actor::Authentication,
    agents::{
        policy as flags,
        providers::{ModelClaims, RuntimeCredential},
    },
};
impl Service {
    /// Called only after model-access signature/claims validation. The run and
    /// membership are rechecked before either managed or stored credentials open.
    pub async fn runtime_credential(
        &self,
        claims: &ModelClaims,
        staging: bool,
        features: &Value,
    ) -> Result<Option<RuntimeCredential>, StoreError> {
        let actor = Actor {
            user_id: claims.sub.clone(),
            workspace_id: claims.workspace_id.clone(),
            workspace_role: String::new(),
            authentication: Authentication::Agent {
                run_id: claims.run_id.clone(),
                token_id: claims.token_id.clone(),
            },
            scopes: Some(Vec::new()),
            loop_scope: None,
        };
        let mut tx = self.database.begin().await?;
        let actor = current_actor(&mut tx, &actor).await?;
        if let Some(key) = policy::managed_key(
            &claims.connection_id,
            &claims.workspace_id,
            &claims.provider,
            &claims.model_id,
            &self.managed_environment,
        ) {
            tx.commit().await?;
            return Ok(Some(RuntimeCredential {
                api_key: key.into(),
                provider: "openai".into(),
                endpoint_url: None,
            }));
        }
        // Staging may use only its registered managed account. Imported/BYOK
        // connections must not provide a route to a production provider account.
        if staging {
            tx.commit().await?;
            return Ok(None);
        }
        let id = Uuid::parse_str(&claims.connection_id).map_err(|_| StoreError::InvalidInput)?;
        let row:Option<Connection>=sqlx::query_as("SELECT c.* FROM model_connections c WHERE c.id=$1 AND c.workspace_id=$2 AND c.provider=$3 AND c.execution_kind='forge-native' AND c.status='ready' AND (c.scope='workspace' OR (c.scope='personal' AND c.user_id=$4)) AND EXISTS(SELECT 1 FROM model_catalog_entries e WHERE e.connection_id=c.id AND e.provider_model_id=$5 AND e.status='available' AND (NOT $6 OR e.execution_kind='forge-native')) AND (NOT $6 OR (c.scope='workspace' AND c.locality='server-capable'))")
            .bind(id).bind(&actor.workspace_id).bind(&claims.provider).bind(&actor.user_id).bind(&claims.model_id).bind(server_only(&actor)).fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        if !flags::provider_enabled(features, &row.provider)
            || self.provider_allowed(&row.provider).is_err()
        {
            tx.commit().await?;
            return Ok(None);
        }
        let Some(reference) = row.secret_reference else {
            tx.commit().await?;
            return Ok(None);
        };
        if policy::execution_endpoint(&row.provider).is_none()
            && !(row.provider.starts_with("custom-") && row.endpoint_url.is_some())
        {
            tx.commit().await?;
            return Ok(None);
        }
        let key = self.vault.open(&reference, &context(&actor, id))?;
        tx.commit().await?;
        Ok(Some(RuntimeCredential {
            api_key: key,
            provider: row.provider,
            endpoint_url: row.endpoint_url,
        }))
    }
}
