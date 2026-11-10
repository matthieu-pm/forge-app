use crate::{StoreError, accounts::session_user_tx};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub logo: Option<String>,
    pub metadata: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub id: String,
    pub organization_id: String,
    pub email: String,
    pub role: Option<String>,
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub inviter_id: String,
}

fn has_role(role: &str, allowed: &[&str]) -> bool {
    role.split(',')
        .map(str::trim)
        .any(|role| allowed.contains(&role))
}

async fn member_role(
    connection: &mut PgConnection,
    workspace: &str,
    user: &str,
) -> Result<String, StoreError> {
    let role: Option<(String,)> =
        sqlx::query_as("SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE")
            .bind(workspace)
            .bind(user)
            .fetch_optional(connection)
            .await?;
    role.map(|(role,)| role)
        .filter(|role| !role.is_empty())
        .ok_or(StoreError::Forbidden)
}

pub async fn list(pool: &crate::Database, token: &str) -> Result<Vec<Workspace>, StoreError> {
    let mut tx = pool.begin().await?;
    let (_, user) = session_user_tx(&mut tx, token).await?;
    let result=sqlx::query_as::<_,Workspace>("SELECT o.* FROM organization o JOIN member m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at,o.id")
        .bind(&user.id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn slug_available(
    pool: &crate::Database,
    token: &str,
    slug: &str,
) -> Result<bool, StoreError> {
    let mut tx = pool.begin().await?;
    session_user_tx(&mut tx, token).await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization WHERE slug=$1)")
            .bind(slug)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(!exists)
}

pub async fn create(
    pool: &crate::Database,
    token: &str,
    name: &str,
    slug: &str,
    logo: Option<&str>,
) -> Result<Workspace, StoreError> {
    let identity = crate::authority::session_identity(pool, token).await?;
    if !identity.email_verified {
        return Err(StoreError::EmailNotVerified);
    }
    let mut tx = pool.begin().await?;
    let id = Uuid::new_v4().to_string();
    let workspace=sqlx::query_as::<_,Workspace>("INSERT INTO organization(id,name,slug,logo) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO NOTHING RETURNING *")
        .bind(&id).bind(name).bind(slug).bind(logo).fetch_optional(&mut *tx).await?.ok_or(StoreError::Conflict)?;
    let (session, user) = session_user_tx(&mut tx, token).await?;
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')")
        .bind(Uuid::new_v4().to_string())
        .bind(&id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.prepare().await?;
    sqlx::query("UPDATE session SET active_organization_id=$1 WHERE id=$2")
        .bind(&id)
        .bind(&session.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(workspace)
}

pub async fn set_active(
    pool: &crate::Database,
    token: &str,
    workspace_id: Option<&str>,
) -> Result<Option<Workspace>, StoreError> {
    let mut tx = pool.begin().await?;
    if let Some(id) = workspace_id {
        lock_workspace(&mut tx, id, false).await?;
    }
    let (session, user) = session_user_tx(&mut tx, token).await?;
    let workspace = if let Some(id) = workspace_id {
        member_role(&mut tx, id, &user.id).await?;
        Some(
            sqlx::query_as::<_, Workspace>("SELECT * FROM organization WHERE id=$1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?,
        )
    } else {
        None
    };
    tx.prepare().await?;
    sqlx::query("UPDATE session SET active_organization_id=$1 WHERE id=$2")
        .bind(workspace_id)
        .bind(&session.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(workspace)
}

pub async fn update(
    pool: &crate::Database,
    token: &str,
    workspace_id: &str,
    name: Option<&str>,
    slug: Option<&str>,
    logo: Option<Option<&str>>,
) -> Result<Workspace, StoreError> {
    let mut tx = pool.begin().await?;
    // Organization locks precede session/member locks. A cascading deletion
    // also updates session rows, so reversing this order creates a lock cycle.
    lock_workspace(&mut tx, workspace_id, true).await?;
    let (_, user) = session_user_tx(&mut tx, token).await?;
    let role = member_role(&mut tx, workspace_id, &user.id).await?;
    if !has_role(&role, &["owner", "admin"]) {
        return Err(StoreError::Forbidden);
    }
    let existing =
        sqlx::query_as::<_, Workspace>("SELECT * FROM organization WHERE id=$1 FOR UPDATE")
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await?;
    let updated = sqlx::query_as::<_, Workspace>(
        "UPDATE organization SET name=$1,slug=$2,logo=$3 WHERE id=$4 RETURNING *",
    )
    .bind(name.unwrap_or(&existing.name))
    .bind(slug.unwrap_or(&existing.slug))
    .bind(logo.unwrap_or(existing.logo.as_deref()))
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(updated)
}

pub async fn delete(
    pool: &crate::Database,
    token: &str,
    workspace_id: &str,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    lock_workspace(&mut tx, workspace_id, true).await?;
    let (_, user) = session_user_tx(&mut tx, token).await?;
    let role = member_role(&mut tx, workspace_id, &user.id).await?;
    if !has_role(&role, &["owner"]) {
        return Err(StoreError::Forbidden);
    }
    tx.prepare().await?;
    sqlx::query("DELETE FROM organization WHERE id=$1")
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn accept_invitation(
    pool: &crate::Database,
    token: &str,
    invitation_id: &str,
) -> Result<Invitation, StoreError> {
    let mut tx = pool.begin().await?;
    let source: Option<(String,)> =
        sqlx::query_as("SELECT organization_id FROM invitation WHERE id=$1")
            .bind(invitation_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (workspace_id,) = source.ok_or(StoreError::Forbidden)?;
    lock_workspace(&mut tx, &workspace_id, false).await?;
    let (session, user) = session_user_tx(&mut tx, token).await?;
    let invitation =
        sqlx::query_as::<_, Invitation>("SELECT * FROM invitation WHERE id=$1 FOR UPDATE")
            .bind(invitation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(StoreError::Forbidden)?;
    if invitation.organization_id != workspace_id
        || invitation.email.to_lowercase() != user.email.to_lowercase()
        || invitation.status != "pending"
        || invitation.expires_at <= Utc::now()
    {
        return Err(StoreError::Forbidden);
    }
    let role = invitation.role.as_deref().unwrap_or("member");
    // The capacity trigger's failure rolls back the WHOLE invitation acceptance.
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,user_id) DO NOTHING")
        .bind(Uuid::new_v4().to_string()).bind(&invitation.organization_id).bind(&user.id).bind(role).execute(&mut *tx).await?;
    tx.prepare().await?;
    let accepted = sqlx::query_as::<_, Invitation>(
        "UPDATE invitation SET status='accepted' WHERE id=$1 RETURNING *",
    )
    .bind(&invitation.id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE session SET active_organization_id=$1 WHERE id=$2")
        .bind(&invitation.organization_id)
        .bind(&session.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(accepted)
}

async fn lock_workspace(
    connection: &mut PgConnection,
    id: &str,
    exclusive: bool,
) -> Result<(), StoreError> {
    let query = if exclusive {
        "SELECT id FROM organization WHERE id=$1 FOR UPDATE"
    } else {
        "SELECT id FROM organization WHERE id=$1 FOR KEY SHARE"
    };
    sqlx::query(query)
        .bind(id)
        .fetch_optional(connection)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
