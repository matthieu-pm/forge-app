use crate::StoreError;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use forge_core::actor::{Actor, Authentication, permissions_to_scopes};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub id: String,
    pub user_id: String,
    pub active_organization_id: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub email: String,
    pub name: String,
    pub image: Option<String>,
    pub email_verified: bool,
}

pub async fn session_identity(
    pool: &crate::Database,
    token: &str,
) -> Result<SessionIdentity, StoreError> {
    sqlx::query_as::<_, SessionIdentity>(
        r#"SELECT s.id, s.user_id, s.active_organization_id, s.expires_at,
                  s.created_at, s.updated_at, u.email, u.name, u.image, u.email_verified
           FROM session s JOIN "user" u ON u.id=s.user_id
           WHERE s.token=$1 AND s.expires_at>clock_timestamp()"#,
    )
    .bind(token)
    .fetch_optional(pool.pool())
    .await?
    .ok_or(StoreError::Unauthenticated)
}

pub async fn session_actor(pool: &crate::Database, token: &str) -> Result<Actor, StoreError> {
    let mut tx = pool.begin().await?;
    // Stabilize candidate workspaces before locking a session that a concurrent
    // organization deletion may need to clear through its foreign key.
    sqlx::query("SELECT o.id FROM organization o JOIN member m ON m.organization_id=o.id JOIN session s ON s.user_id=m.user_id WHERE s.token=$1 AND s.expires_at>clock_timestamp() ORDER BY o.id FOR KEY SHARE OF o")
        .bind(token).fetch_all(&mut *tx).await?;
    let row: Option<(String, String, Option<String>, bool)> = sqlx::query_as(
        r#"SELECT s.id, s.user_id, s.active_organization_id, u.email_verified
           FROM session s JOIN "user" u ON u.id=s.user_id
           WHERE s.token=$1 AND s.expires_at>clock_timestamp() FOR UPDATE OF s FOR SHARE OF u"#,
    )
    .bind(token)
    .fetch_optional(&mut *tx)
    .await?;
    let (session_id, user_id, active_workspace, verified) =
        row.ok_or(StoreError::Unauthenticated)?;
    if !verified {
        return Err(StoreError::EmailNotVerified);
    }
    let mut membership: Option<(String, String)> = if let Some(workspace) =
        active_workspace.as_deref()
    {
        sqlx::query_as("SELECT organization_id,role FROM member WHERE user_id=$1 AND organization_id=$2 FOR SHARE")
            .bind(&user_id).bind(workspace).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    if membership.is_none() {
        membership = sqlx::query_as(
            "SELECT m.organization_id,m.role FROM member m JOIN organization o ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.created_at,o.id LIMIT 1 FOR SHARE OF m",
        ).bind(&user_id).fetch_optional(&mut *tx).await?;
    }
    let (workspace_id, workspace_role) = membership.ok_or(StoreError::NoActiveWorkspace)?;
    if workspace_role.is_empty() {
        return Err(StoreError::Forbidden);
    }
    if active_workspace.as_deref() != Some(&workspace_id) {
        tx.prepare().await?;
        sqlx::query("UPDATE session SET active_organization_id=$1 WHERE id=$2")
            .bind(&workspace_id)
            .bind(&session_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Actor {
        user_id,
        workspace_id,
        workspace_role,
        authentication: Authentication::Session { session_id },
        scopes: None,
        loop_scope: None,
    })
}

#[derive(Debug, FromRow)]
struct KeyRecord {
    id: String,
    reference_id: String,
    config_id: String,
    enabled: bool,
    expires_at: Option<DateTime<Utc>>,
    permissions: Option<String>,
    metadata: Option<String>,
    rate_limit_enabled: bool,
    rate_limit_time_window: Option<i32>,
    rate_limit_max: Option<i32>,
    request_count: i32,
    last_request: Option<DateTime<Utc>>,
    remaining: Option<i32>,
    refill_interval: Option<i32>,
    refill_amount: Option<i32>,
    last_refill_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

fn key_workspace(key: &KeyRecord) -> Result<String, StoreError> {
    let metadata: Value = serde_json::from_str(key.metadata.as_deref().unwrap_or("null"))
        .map_err(|_| StoreError::Forbidden)?;
    metadata
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or(StoreError::Forbidden)
}

fn key_scopes(key: &KeyRecord) -> Result<Vec<forge_core::actor::ApiScope>, StoreError> {
    let permissions: Value = serde_json::from_str(key.permissions.as_deref().unwrap_or("null"))
        .map_err(|_| StoreError::Forbidden)?;
    Ok(permissions_to_scopes(&permissions))
}

pub fn api_key_hash(credential: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes()))
}

pub async fn api_key_actor(pool: &crate::Database, credential: &str) -> Result<Actor, StoreError> {
    if credential.is_empty() {
        return Err(StoreError::Unauthenticated);
    }
    let mut tx = pool.begin().await?;
    let mut key = sqlx::query_as::<_, KeyRecord>("SELECT * FROM apikey WHERE key=$1 FOR UPDATE")
        .bind(api_key_hash(credential))
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::Unauthenticated)?;
    let now = Utc::now();
    if key.config_id != "forge-api" || !key.enabled || key.expires_at.is_some_and(|at| at <= now) {
        return Err(StoreError::Unauthenticated);
    }
    let workspace_id = key_workspace(&key)?;
    let scopes = key_scopes(&key)?;
    let role: Option<(String,)> =
        sqlx::query_as("SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE")
            .bind(&workspace_id)
            .bind(&key.reference_id)
            .fetch_optional(&mut *tx)
            .await?;
    let workspace_role = role
        .filter(|(role,)| !role.is_empty())
        .ok_or(StoreError::Forbidden)?
        .0;
    if let Some(remaining) = key.remaining {
        let refilled = match (key.refill_interval, key.refill_amount) {
            (Some(interval), Some(amount))
                if interval > 0
                    && amount > 0
                    && (now - key.last_refill_at.unwrap_or(key.created_at)).num_milliseconds()
                        > i64::from(interval) =>
            {
                key.last_refill_at = Some(now);
                Some(amount)
            }
            _ => None,
        };
        let available = refilled.unwrap_or(remaining);
        if available <= 0 {
            return Err(StoreError::RateLimited);
        }
        key.remaining = Some(available - 1);
    }
    let mut last_request = key.last_request;
    if !key.rate_limit_enabled {
        last_request = Some(now);
    } else if let (Some(window), Some(maximum)) = (key.rate_limit_time_window, key.rate_limit_max) {
        if key
            .last_request
            .is_none_or(|at| (now - at).num_milliseconds() > i64::from(window))
        {
            key.request_count = 1;
        } else if key.request_count >= maximum {
            return Err(StoreError::RateLimited);
        } else {
            key.request_count += 1;
        }
        last_request = Some(now);
    }
    sqlx::query("UPDATE apikey SET request_count=$1,last_request=$2,remaining=$3,last_refill_at=$4,updated_at=$5 WHERE id=$6")
        .bind(key.request_count).bind(last_request).bind(key.remaining).bind(key.last_refill_at).bind(now).bind(&key.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Actor {
        user_id: key.reference_id,
        workspace_id,
        workspace_role,
        authentication: Authentication::ApiKey {
            credential_id: key.id,
        },
        scopes: Some(scopes),
        loop_scope: None,
    })
}

/// Called inside every command transaction, before either replay or execution.
/// The live records stay locked until that transaction commits or rolls back.
pub async fn current_actor(
    connection: &mut PgConnection,
    actor: &Actor,
) -> Result<Actor, StoreError> {
    let mut current = actor.clone();
    match &actor.authentication {
        Authentication::Session { session_id } => {
            let valid: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM session WHERE id=$1 AND user_id=$2 AND active_organization_id=$3 AND expires_at>clock_timestamp() FOR SHARE",
            ).bind(session_id).bind(&actor.user_id).bind(&actor.workspace_id).fetch_optional(&mut *connection).await?;
            if valid.is_none() {
                return Err(StoreError::Forbidden);
            }
        }
        Authentication::ApiKey { credential_id } => {
            let key = sqlx::query_as::<_, KeyRecord>("SELECT * FROM apikey WHERE id=$1 FOR SHARE")
                .bind(credential_id)
                .fetch_optional(&mut *connection)
                .await?
                .ok_or(StoreError::Forbidden)?;
            if !key.enabled
                || key.config_id != "forge-api"
                || key.reference_id != actor.user_id
                || key.expires_at.is_some_and(|at| at <= Utc::now())
                || key_workspace(&key)? != actor.workspace_id
            {
                return Err(StoreError::Forbidden);
            }
            current.scopes = Some(
                key_scopes(&key)?
                    .into_iter()
                    .filter(|scope| {
                        actor
                            .scopes
                            .as_ref()
                            .is_some_and(|scopes| scopes.contains(scope))
                    })
                    .collect(),
            );
        }
        Authentication::Agent { run_id, .. } => {
            let run_id = uuid::Uuid::parse_str(run_id).map_err(|_| StoreError::Forbidden)?;
            let row: Option<(String, String)> = sqlx::query_as(
                "SELECT r.requested_selection::text,r.state FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE r.id=$1 AND r.initiated_by_user_id=$2 AND t.workspace_id=$3 AND r.state IN ('running','waiting-for-approval','reconnecting') FOR SHARE OF r,t",
            ).bind(run_id).bind(&actor.user_id).bind(&actor.workspace_id).fetch_optional(&mut *connection).await?;
            let (selection, state) = row.ok_or(StoreError::Forbidden)?;
            let selection =
                forge_core::json::parse(&selection).map_err(|_| StoreError::Forbidden)?;
            // Ordinary agent callbacks never query loop tables. A linked run
            // has both the agent-run grant and the current loop/source grant.
            if let Some(loop_run) = selection.get("loopRunId").and_then(Value::as_str) {
                if state == "reconnecting" {
                    return Err(StoreError::Forbidden);
                }
                return crate::loops::current_loop_actor(connection, actor, loop_run).await;
            }
        }
        Authentication::Loop { run_id, .. } => {
            return crate::loops::current_loop_actor(connection, actor, run_id).await;
        }
    }
    if current.loop_scope.is_some() {
        return Err(StoreError::Forbidden);
    }
    let membership: Option<(String,)> =
        sqlx::query_as("SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE")
            .bind(&actor.workspace_id)
            .bind(&actor.user_id)
            .fetch_optional(connection)
            .await?;
    current.workspace_role = membership.ok_or(StoreError::Forbidden)?.0;
    Ok(current)
}
