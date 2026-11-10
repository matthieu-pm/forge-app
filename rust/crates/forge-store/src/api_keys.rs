use crate::{
    Database, StoreError,
    authority::{api_key_hash, current_actor},
    security,
    workspaces::lock_workspace,
};
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication, permissions_to_scopes},
    security::SecurityAction,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateKey {
    pub name: String,
    #[serde(default = "default_expiry")]
    pub expires_in_days: i32,
    pub scopes: Vec<ApiScope>,
}
fn default_expiry() -> i32 {
    90
}

#[derive(FromRow, Deserialize)]
struct Key {
    id: String,
    name: Option<String>,
    start: Option<String>,
    permissions: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    last_request: Option<DateTime<Utc>>,
    enabled: bool,
}
impl Key {
    fn summary(self) -> Value {
        let permissions = self
            .permissions
            .as_deref()
            .and_then(|v| serde_json::from_str(v).ok())
            .unwrap_or(Value::Null);
        json!({"id":self.id,"name":self.name,"start":self.start,"scopes":permissions_to_scopes(&permissions),"createdAt":self.created_at,"expiresAt":self.expires_at,"lastRequest":self.last_request,"enabled":self.enabled})
    }
}
pub async fn create(
    database: &Database,
    actor: &Actor,
    input: &CreateKey,
) -> Result<Value, StoreError> {
    let name = forge_core::text::trim(&input.name);
    if name.is_empty()
        || forge_core::text::length(name) > 32
        || !(1..=365).contains(&input.expires_in_days)
        || input.scopes.is_empty()
    {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = security::authorize(&mut tx, actor, SecurityAction::ApiKeysCreate).await?;
    let credential = format!("forge_{}", forge_identity::random_token(64));
    let mut permissions = serde_json::Map::new();
    for scope in &input.scopes {
        let value = serde_json::to_value(scope).map_err(|_| StoreError::InvalidInput)?;
        let (resource, action) = value
            .as_str()
            .and_then(|s| s.split_once(':'))
            .ok_or(StoreError::InvalidInput)?;
        let actions = permissions
            .entry(resource)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or(StoreError::InvalidInput)?;
        if !actions.iter().any(|v| v == action) {
            actions.push(json!(action));
        }
    }
    let key=sqlx::query_as::<_,Key>("INSERT INTO apikey(id,config_id,name,start,reference_id,prefix,key,rate_limit_time_window,rate_limit_max,expires_at,permissions,metadata) VALUES($1,'forge-api',$2,$3,$4,'forge_',$5,60000,600,clock_timestamp()+$6*interval '1 day',$7,$8) RETURNING *")
        .bind(Uuid::new_v4().to_string()).bind(name).bind(&credential[..6]).bind(&live.user_id).bind(api_key_hash(&credential)).bind(input.expires_in_days).bind(Value::Object(permissions).to_string()).bind(json!({"workspaceId":live.workspace_id}).to_string()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"key":credential,"summary":key.summary()}))
}

pub async fn list(database: &Database, actor: &Actor) -> Result<Vec<Value>, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. }) {
        return Err(StoreError::Forbidden);
    }
    // Metadata was written by Better Auth as text. Invalid historical metadata
    // is ignored rather than cast in PostgreSQL, where one bad row breaks lists.
    let rows:Vec<(Value,Option<String>)>=sqlx::query_as("SELECT to_jsonb(k),metadata FROM apikey k WHERE config_id='forge-api' AND reference_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(&live.user_id).fetch_all(&mut *tx).await?;
    let mut values = Vec::new();
    for (row, metadata) in rows {
        if metadata
            .as_deref()
            .and_then(|v| serde_json::from_str::<Value>(v).ok())
            .is_some_and(|v| v["workspaceId"] == live.workspace_id)
        {
            let key: Key = serde_json::from_value(row).map_err(|_| StoreError::InvalidInput)?;
            values.push(key.summary());
        }
    }
    tx.commit().await?;
    Ok(values)
}

pub async fn revoke(database: &Database, actor: &Actor, id: &str) -> Result<(), StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. }) {
        return Err(StoreError::Forbidden);
    }
    let metadata:Option<(Option<String>,)>=sqlx::query_as("SELECT metadata FROM apikey WHERE id=$1 AND config_id='forge-api' AND reference_id=$2 FOR UPDATE").bind(id).bind(&live.user_id).fetch_optional(&mut *tx).await?;
    let belongs = metadata
        .and_then(|r| r.0)
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .is_some_and(|v| v["workspaceId"] == live.workspace_id);
    if !belongs {
        return Err(StoreError::NotFound);
    }
    tx.prepare().await?;
    sqlx::query("DELETE FROM apikey WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn policy(database: &Database, actor: &Actor) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. }) {
        return Err(StoreError::Forbidden);
    }
    let value = security::api_key_policy(&mut tx, &live).await?;
    tx.commit().await?;
    Ok(value)
}
