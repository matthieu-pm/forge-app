use crate::{
    Database, StoreError, accounts::session_user_tx, security, workspaces::lock_workspace,
};
use forge_core::actor::{Actor, Authentication};
use forge_identity::invite::InviteClaims;
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

#[derive(FromRow)]
struct Workspace {
    id: String,
    name: String,
    slug: String,
}
async fn invite_workspace(
    connection: &mut PgConnection,
    claims: &InviteClaims,
) -> Result<Workspace, StoreError> {
    sqlx::query_as("SELECT o.id,o.name,o.slug FROM organization o JOIN workspace_security_settings s ON s.workspace_id=o.id WHERE o.id=$1 AND s.invite_links_enabled AND s.invite_link_version=$2 FOR SHARE OF s")
        .bind(&claims.workspace_id).bind(claims.generation).fetch_optional(connection).await?.ok_or(StoreError::Forbidden)
}
pub async fn preview(database: &Database, token: &str, secret: &str) -> Result<Value, StoreError> {
    let claims = InviteClaims::verify(token, secret).map_err(|_| StoreError::InvalidInput)?;
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &claims.workspace_id, false).await?;
    let workspace = invite_workspace(&mut tx, &claims).await?;
    tx.commit().await?;
    Ok(json!({"workspaceName":workspace.name,"workspaceSlug":workspace.slug}))
}
pub async fn join_invite(
    database: &Database,
    session_token: &str,
    invite_token: &str,
    secret: &str,
) -> Result<Value, StoreError> {
    let claims =
        InviteClaims::verify(invite_token, secret).map_err(|_| StoreError::InvalidInput)?;
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &claims.workspace_id, false).await?;
    let workspace = invite_workspace(&mut tx, &claims).await?;
    join(
        &mut tx,
        session_token,
        &workspace,
        "security.invite-link.used",
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(
        json!({"workspaceId":workspace.id,"workspaceName":workspace.name,"workspaceSlug":workspace.slug}),
    )
}
pub async fn approved_workspace(
    database: &Database,
    session_token: &str,
) -> Result<Value, StoreError> {
    let identity = crate::authority::session_identity(database, session_token).await?;
    if !identity.email_verified {
        return Err(StoreError::EmailNotVerified);
    }
    let domain = email_domain(&identity.email).ok_or(StoreError::InvalidInput)?;
    let workspace:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('workspaceId',o.id,'workspaceName',o.name,'workspaceSlug',o.slug,'domain',d.domain) FROM organization o JOIN workspace_approved_domains d ON d.workspace_id=o.id WHERE d.domain=$1 AND d.verified_at IS NOT NULL").bind(domain).fetch_optional(database.pool()).await?;
    Ok(workspace.unwrap_or(Value::Null))
}
pub async fn join_domain(
    database: &Database,
    session_token: &str,
    workspace_id: &str,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, workspace_id, false).await?;
    // Verified email is read under the session/user lock, never taken from input.
    let (_, user) = session_user_tx(&mut tx, session_token).await?;
    let domain = email_domain(&user.email).ok_or(StoreError::InvalidInput)?;
    let workspace:Workspace=sqlx::query_as("SELECT o.id,o.name,o.slug FROM organization o JOIN workspace_approved_domains d ON d.workspace_id=o.id WHERE o.id=$1 AND d.domain=$2 AND d.verified_at IS NOT NULL FOR SHARE OF d")
        .bind(workspace_id).bind(&domain).fetch_optional(&mut *tx).await?.ok_or(StoreError::Forbidden)?;
    join(
        &mut tx,
        session_token,
        &workspace,
        "security.approved-domain.used",
        Some(&domain),
    )
    .await?;
    tx.commit().await?;
    Ok(
        json!({"workspaceId":workspace.id,"workspaceName":workspace.name,"workspaceSlug":workspace.slug,"domain":domain}),
    )
}
fn email_domain(email: &str) -> Option<String> {
    let (local, domain) = email.rsplit_once('@')?;
    if local.is_empty() {
        return None;
    }
    forge_core::security::normalized_domain(domain)
}
async fn join(
    tx: &mut crate::database::JournalTransaction,
    token: &str,
    workspace: &Workspace,
    action: &str,
    target: Option<&str>,
) -> Result<(), StoreError> {
    let (session, user) = session_user_tx(tx, token).await?;
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT(organization_id,user_id) DO NOTHING")
        .bind(Uuid::new_v4().to_string()).bind(&workspace.id).bind(&user.id).execute(&mut **tx).await?;
    let actor = Actor {
        user_id: user.id,
        workspace_id: workspace.id.clone(),
        workspace_role: "member".into(),
        authentication: Authentication::Session {
            session_id: session.id.clone(),
        },
        scopes: None,
        loop_scope: None,
    };
    security::audit(
        tx,
        &actor,
        action,
        target,
        "succeeded",
        None,
        Some(json!({"membershipRole":"member"})),
    )
    .await?;
    tx.prepare().await?;
    sqlx::query("UPDATE session SET active_organization_id=$1 WHERE id=$2")
        .bind(&workspace.id)
        .bind(&session.id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
