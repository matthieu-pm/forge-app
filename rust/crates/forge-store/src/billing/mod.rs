//! Internal billing commands. Neither browser amounts nor provider observations
//! acquire payment authority here. Runtime admission remains gated until the
//! trusted pricing, dispatch and settlement pipeline is integrated.
use crate::{Database, StoreError, authority::current_actor};
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    billing as policy,
};
use policy::calendar::{date, stamp};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;
mod ledger;
mod management;
mod projection;
mod reads;
mod trial;

#[derive(Clone)]
pub struct Service {
    pub database: Database,
}
impl Service {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
}
fn fail(code: &'static str) -> StoreError {
    policy::Error(code).into()
}
fn invalid() -> StoreError {
    StoreError::InvalidInput
}
fn text(value: &Value) -> Result<&str, StoreError> {
    value.as_str().ok_or_else(invalid)
}
fn id(value: &Value) -> Result<Uuid, StoreError> {
    let s = text(value)?;
    if !forge_core::text::is_uuid(s) {
        return Err(invalid());
    }
    s.parse().map_err(|_| invalid())
}
fn fields(value: &Value, names: &[&str]) -> Result<(), StoreError> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != names.len() || object.keys().any(|k| !names.contains(&k.as_str())) {
        return Err(invalid());
    }
    Ok(())
}
fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).expect("valid clock")
}
#[derive(FromRow)]
struct Workspace {
    id: String,
    created_at: DateTime<Utc>,
}
async fn fence(
    c: &mut PgConnection,
    workspace: &str,
) -> Result<(Workspace, DateTime<Utc>), StoreError> {
    let row =
        sqlx::query_as("SELECT id,created_at FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(workspace)
            .fetch_optional(&mut *c)
            .await?
            .ok_or_else(|| fail("USAGE_WORKSPACE_NOT_FOUND"))?;
    let at = sqlx::query_scalar("SELECT date_trunc('milliseconds',clock_timestamp())")
        .fetch_one(c)
        .await?;
    Ok((row, at))
}
async fn live(c: &mut PgConnection, actor: &Actor, trial: bool) -> Result<Actor, StoreError> {
    if !matches!(actor.authentication, Authentication::Session { .. }) {
        return Err(StoreError::Forbidden);
    }
    // Match identity deletion's FK lock order before session/membership locks.
    let verified: Option<bool> =
        sqlx::query_scalar("SELECT email_verified FROM \"user\" WHERE id=$1 FOR SHARE")
            .bind(&actor.user_id)
            .fetch_optional(&mut *c)
            .await?;
    let revoked = if trial {
        "TRIAL_ACTOR_REVOKED"
    } else {
        "USAGE_ACTOR_REVOKED"
    };
    let current = current_actor(c, actor).await.map_err(|e| match e {
        StoreError::Forbidden => fail(revoked),
        other => other,
    })?;
    let roles: &[&str] = if trial {
        &["owner", "admin"]
    } else {
        &["owner", "admin", "member", "guest"]
    };
    if !current.has_role(roles) {
        return Err(fail(revoked));
    }
    if verified != Some(true) {
        return Err(fail(if trial {
            "TRIAL_EMAIL_VERIFICATION_REQUIRED"
        } else {
            "USAGE_EMAIL_VERIFICATION_REQUIRED"
        }));
    }
    Ok(current)
}
async fn state(c: &mut PgConnection, workspace: &str) -> Result<Value, StoreError> {
    let raw: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1",
    )
    .bind(workspace)
    .fetch_optional(c)
    .await?;
    Ok(raw.map(camel_columns).unwrap_or(Value::Null))
}
fn camel_columns(raw: Value) -> Value {
    let Value::Object(raw) = raw else {
        return Value::Null;
    };
    let mut result = serde_json::Map::new();
    // Only database column names change. Frozen refund records already use the
    // source's camelCase keys and must remain byte-for-byte values.
    for (name, value) in raw {
        let mut parts = name.split('_');
        let mut key = parts.next().unwrap_or_default().to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                key.extend(first.to_uppercase());
                key.extend(chars);
            }
        }
        result.insert(key, value);
    }
    Value::Object(result)
}
async fn audit(
    c: &mut PgConnection,
    workspace: &str,
    actor: Option<&str>,
    action: &str,
    target: &str,
    request: &str,
    after: Value,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO workspace_security_audit_events(workspace_id,actor_user_id,action,target,outcome,request_id,\"after\") VALUES($1,$2,$3,$4,'succeeded',$5,$6)")
        .bind(workspace).bind(actor).bind(action).bind(target).bind(request).bind(after).execute(c).await?;
    Ok(())
}
