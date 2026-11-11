use super::*;
#[derive(sqlx::FromRow)]
pub(super) struct Connection {
    pub id: Uuid,
    pub workspace_id: String,
    pub user_id: Option<String>,
    pub scope: String,
    pub provider: String,
    pub kind: String,
    pub execution_kind: String,
    pub locality: String,
    pub billing_mode: String,
    pub credential_owner: String,
    pub display_name: String,
    pub masked_credential_suffix: Option<String>,
    pub secret_reference: Option<String>,
    pub endpoint_url: Option<String>,
    pub status: String,
    pub status_reason: Option<String>,
    pub discovered_at: Option<DateTime<Utc>>,
    pub last_health_checked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
pub(super) async fn accessible(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<Connection, StoreError> {
    let query = format!(
        "SELECT * FROM model_connections WHERE id=$3 AND workspace_id=$1 AND (scope='workspace' OR user_id=$2){}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(&actor.user_id)
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| {
            error(
                Code::ConnectionNotFound,
                "The model connection was not found.",
            )
        })
}
pub(super) async fn summary(
    conn: &mut PgConnection,
    row: &Connection,
) -> Result<Value, StoreError> {
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM model_catalog_entries WHERE connection_id=$1")
            .bind(row.id)
            .fetch_one(conn)
            .await?;
    models::connection(json!({"id":row.id,"workspaceId":row.workspace_id,"userId":row.user_id,"scope":row.scope,"provider":row.provider,"kind":row.kind,"executionKind":row.execution_kind,"locality":row.locality,"billingMode":row.billing_mode,"credentialOwner":row.credential_owner,"displayName":row.display_name,"maskedCredentialSuffix":row.masked_credential_suffix,"endpointUrl":row.endpoint_url,"status":row.status,"statusReason":row.status_reason,"discoveredAt":row.discovered_at.map(iso),"lastHealthCheckedAt":row.last_health_checked_at.map(iso),"createdAt":iso(row.created_at),"updatedAt":iso(row.updated_at),"modelCount":count})).map_err(|_|StoreError::InvalidInput)
}
pub(super) async fn replace_catalog(
    conn: &mut PgConnection,
    row: &Connection,
    models: &[Model],
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM model_catalog_entries WHERE connection_id=$1")
        .bind(row.id)
        .execute(&mut *conn)
        .await?;
    for model in models {
        sqlx::query("INSERT INTO model_catalog_entries(connection_id,selection_id,provider_model_id,display_name,provider_label,source_label,execution_kind,input_modalities,supports_tools,supports_code,supported_reasoning_efforts,context_window_tokens,status,discovered_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'forge-native',$7,$8,$9,$10,$11,'available',$12,$12,$12)")
            .bind(row.id).bind(format!("{}:{}",row.id,model.model_id)).bind(&model.model_id).bind(&model.display_name).bind(policy::label(&row.provider)).bind(if row.scope=="personal"{"Personal API"}else{"Workspace API"}).bind(json!(model.input_modalities)).bind(model.supports_tools).bind(model.supports_code).bind(json!(model.supported_reasoning_efforts)).bind(model.context_window_tokens).bind(now).execute(&mut *conn).await?;
    }
    Ok(())
}
