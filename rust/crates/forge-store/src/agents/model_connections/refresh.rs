use super::*;
impl Service {
    pub async fn refresh(&self, actor: &Actor, id: Uuid) -> Result<Value, StoreError> {
        self.refresh_one(actor, id, false).await
    }
    pub async fn refresh_for_routing(
        &self,
        actor: &Actor,
        id: Option<Uuid>,
    ) -> Result<(), StoreError> {
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, ApiScope::AgentsWrite).await?;
        let rows: Vec<Connection> = if let Some(id) = id {
            vec![accessible(&mut tx, &actor, id, false).await?]
        } else {
            sqlx::query_as("SELECT * FROM model_connections WHERE workspace_id=$1 AND (scope='workspace' OR user_id=$2)").bind(&actor.workspace_id).bind(&actor.user_id).fetch_all(&mut *tx).await?
        };
        tx.commit().await?;
        futures_util::future::join_all(
            rows.into_iter()
                .filter(|r| self.provider_allowed(&r.provider).is_ok())
                .map(|r| self.refresh_one(&actor, r.id, true)),
        )
        .await;
        Ok(())
    }
    async fn refresh_one(
        &self,
        actor: &Actor,
        id: Uuid,
        routing: bool,
    ) -> Result<Value, StoreError> {
        let scope = if routing {
            ApiScope::AgentsWrite
        } else {
            ApiScope::ModelConnectionsWrite
        };
        let mut tx = self.database.begin().await?;
        let actor = live(&mut tx, actor, scope).await?;
        let before = accessible(&mut tx, &actor, id, false).await?;
        if !routing {
            write_allowed(&actor, &before.scope)?;
        }
        self.provider_allowed(&before.provider)?;
        tx.commit().await?;
        let reference = before.secret_reference.as_ref().ok_or_else(|| {
            error(
                Code::VaultUnavailable,
                "This connection has no server credential.",
            )
        })?;
        let key = self
            .vault
            .open(reference, &context(&actor, id))
            .map_err(|_| {
                error(
                    Code::VaultUnavailable,
                    "The credential vault could not open this connection.",
                )
            })?;
        let result = self
            .discovery
            .discover(&DiscoveryInput {
                provider: before.provider.clone(),
                api_key: key,
                endpoint_url: before.endpoint_url.clone(),
                model_ids: Vec::new(),
            })
            .await;
        let mut tx = self.database.begin().await?;
        let actor = publication_actor(&mut tx, &actor, scope).await?;
        let current = accessible(&mut tx, &actor, id, true).await?;
        if !routing {
            write_allowed(&actor, &current.scope)?;
        }
        self.provider_allowed(&current.provider)?;
        // Another refresh won while provider I/O was pending. Its catalog and
        // health status must not be replaced by this older response.
        if current.updated_at != before.updated_at
            || current.secret_reference != before.secret_reference
        {
            let saved = summary(&mut tx, &current).await?;
            tx.commit().await?;
            return Ok(saved);
        }
        tx.prepare().await?;
        // Keep the optimistic stamp strictly increasing even when two refreshes
        // finish inside one millisecond. Public dates retain millisecond format.
        let now = self
            .time()
            .max(current.updated_at + chrono::Duration::microseconds(1));
        match result {
            Ok(catalog) => {
                replace_catalog(&mut tx, &current, &catalog, now).await?;
                let updated:Connection=sqlx::query_as("UPDATE model_connections SET status=$2,status_reason=$3,discovered_at=$4,last_health_checked_at=$4,updated_at=$4 WHERE id=$1 RETURNING *").bind(id).bind(if catalog.is_empty(){"repair-required"}else{"ready"}).bind(if catalog.is_empty(){Some("No compatible models were returned.")}else{None}).bind(now).fetch_one(&mut *tx).await?;
                let saved = summary(&mut tx, &updated).await?;
                tx.commit().await?;
                Ok(saved)
            }
            Err(_) => {
                sqlx::query("UPDATE model_connections SET status='repair-required',status_reason='Authentication or model discovery failed.',last_health_checked_at=$2,updated_at=$2 WHERE id=$1").bind(id).bind(now).execute(&mut *tx).await?;
                tx.commit().await?;
                Err(error(
                    Code::DiscoveryFailed,
                    "Forge could not authenticate with this provider or refresh its models.",
                ))
            }
        }
    }
}
