use super::*;
#[derive(sqlx::FromRow)]
struct Catalog {
    selection_id: String,
    connection_id: Uuid,
    execution_kind: String,
    provider: String,
    provider_model_id: String,
    display_name: String,
    provider_label: String,
    source_label: String,
    locality: String,
    billing_mode: String,
    input_modalities: Value,
    supports_tools: bool,
    supports_code: bool,
    supported_reasoning_efforts: Value,
    context_window_tokens: Option<i32>,
    status: String,
}
impl Service {
    pub async fn catalog(
        &self,
        actor: &Actor,
        for_routing: bool,
    ) -> Result<Vec<Value>, StoreError> {
        let mut tx = self.database.begin().await?;
        let result = self.catalog_in(&mut tx, actor, for_routing).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub(crate) async fn catalog_in(
        &self,
        tx: &mut crate::database::JournalTransaction,
        actor: &Actor,
        for_routing: bool,
    ) -> Result<Vec<Value>, StoreError> {
        let actor = publication_actor(
            tx,
            actor,
            if for_routing {
                ApiScope::AgentsWrite
            } else {
                ApiScope::ModelConnectionsRead
            },
        )
        .await?;
        let id = policy::managed_id(&actor.workspace_id);
        let mut result = policy::managed_models(&id, &self.managed_environment);
        if !result.is_empty() {
            tx.prepare().await?;
            sqlx::query("INSERT INTO model_connections(id,workspace_id,created_by_user_id,user_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,metadata) VALUES($1,$2,$3,NULL,'workspace','openai','managed','forge-native','server-capable','forge-managed','forge-server-vault','Forge managed OpenAI','ready','{\"source\":\"server-environment\"}') ON CONFLICT DO NOTHING").bind(Uuid::parse_str(&id).map_err(|_|StoreError::InvalidInput)?).bind(&actor.workspace_id).bind(&actor.user_id).execute(&mut **tx).await?;
        }
        let rows:Vec<Catalog>=sqlx::query_as("SELECT e.selection_id,e.connection_id,e.execution_kind,c.provider,e.provider_model_id,e.display_name,e.provider_label,e.source_label,c.locality,c.billing_mode,e.input_modalities,e.supports_tools,e.supports_code,e.supported_reasoning_efforts,e.context_window_tokens,e.status FROM model_catalog_entries e JOIN model_connections c ON c.id=e.connection_id WHERE c.workspace_id=$1 AND (c.scope='workspace' OR c.user_id=$2) AND c.status='ready' AND e.status='available' AND (e.expires_at IS NULL OR e.expires_at>$3) AND (NOT $4 OR (c.scope='workspace' AND c.locality='server-capable' AND c.execution_kind='forge-native' AND e.execution_kind='forge-native'))").bind(&actor.workspace_id).bind(&actor.user_id).bind(self.time()).bind(server_only(&actor)).fetch_all(&mut **tx).await?;
        for row in rows {
            result.push(models::catalog(json!({"selectionId":row.selection_id,"connectionId":row.connection_id,"executionKind":row.execution_kind,"provider":row.provider,"modelId":row.provider_model_id,"displayName":row.display_name,"providerLabel":row.provider_label,"sourceLabel":row.source_label,"locality":row.locality,"billingMode":row.billing_mode,"inputModalities":row.input_modalities,"supportsTools":row.supports_tools,"supportsCode":row.supports_code,"supportedReasoningEfforts":row.supported_reasoning_efforts,"contextWindowTokens":row.context_window_tokens,"status":row.status})).map_err(|_|StoreError::InvalidInput)?);
        }
        Ok(result)
    }
}
