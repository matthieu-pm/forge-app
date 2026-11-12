use crate::{
    Database, StoreError,
    authority::current_actor,
    security,
    workspaces::{Invitation, lock_workspace},
};
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    security::SecurityAction,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub organization_id: String,
    pub user_id: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}
fn owner(role: &str) -> bool {
    role.split(',').any(|r| r.trim() == "owner")
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct MemberSummary {
    id: String,
    user_id: String,
    name: String,
    email: String,
    image: Option<String>,
    username: Option<String>,
    title: Option<String>,
    role: String,
    joined_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
}

pub async fn summary(database: &Database, actor: &Actor) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    if !live.has_scope(ApiScope::TeamsRead) {
        return Err(StoreError::Forbidden);
    }
    let rows=sqlx::query_as::<_,MemberSummary>("SELECT m.id,u.id user_id,u.name,u.email,u.image,u.username,u.title,m.role,m.created_at joined_at,max(s.updated_at) last_seen_at FROM member m JOIN \"user\" u ON u.id=m.user_id LEFT JOIN session s ON s.user_id=u.id AND s.active_organization_id=m.organization_id WHERE m.organization_id=$1 GROUP BY m.id,u.id ORDER BY m.created_at,m.id").bind(&live.workspace_id).fetch_all(&mut *tx).await?;
    let query = format!(
        "SELECT count(*) FROM teams t WHERE {}",
        crate::resource_policy::readable_team(&live, "t.id")
    );
    let teams: i64 = sqlx::query_scalar(&query)
        .bind(&live.workspace_id)
        .bind(crate::resource_policy::privileged(&live))
        .bind(&live.user_id)
        .fetch_one(&mut *tx)
        .await?;
    let now = Utc::now();
    let members: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let online = row
                .last_seen_at
                .is_some_and(|at| now.signed_duration_since(at).num_milliseconds() <= 300000);
            let mut value = serde_json::to_value(row).expect("serializable member");
            value["teamCount"] = json!(teams);
            value["isOnline"] = json!(online);
            value
        })
        .collect();
    let rows=sqlx::query_as::<_,Invitation>("SELECT * FROM invitation WHERE organization_id=$1 AND status='pending' ORDER BY created_at DESC,id").bind(&live.workspace_id).fetch_all(&mut *tx).await?;
    let invitations:Vec<_>=rows.into_iter().map(|r|json!({"id":r.id,"email":r.email,"role":r.role.unwrap_or_else(||"member".into()),"createdAt":r.created_at,"expiresAt":r.expires_at,"expired":r.expires_at<=now})).collect();
    tx.commit().await?;
    Ok(
        json!({"members":members,"invitations":invitations,"currentUserId":live.user_id,"canManage":live.has_role(&["owner","admin"])}),
    )
}

pub async fn change(
    database: &Database,
    actor: &Actor,
    member_id: &str,
    new_role: Option<&str>,
    leaving: bool,
) -> Result<Member, StoreError> {
    if let Some(role) = new_role
        && (leaving
            || role
                .split(',')
                .any(|r| !["owner", "admin", "member"].contains(&r.trim()))
            || role.trim().is_empty())
    {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, true).await?;
    let live = current_actor(&mut tx, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. })
        || (!leaving && !live.has_role(&["owner", "admin"]))
    {
        return Err(StoreError::Forbidden);
    }
    let member = sqlx::query_as::<_, Member>(
        "SELECT * FROM member WHERE id=$1 AND organization_id=$2 FOR UPDATE",
    )
    .bind(member_id)
    .bind(&live.workspace_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    if leaving && member.user_id != live.user_id {
        return Err(StoreError::Forbidden);
    }
    if (owner(&member.role) || new_role.is_some_and(owner)) && !owner(&live.workspace_role) {
        return Err(StoreError::Forbidden);
    }
    if owner(&member.role) && !new_role.is_some_and(owner) {
        let roles: Vec<String> =
            sqlx::query_scalar("SELECT role FROM member WHERE organization_id=$1")
                .bind(&live.workspace_id)
                .fetch_all(&mut *tx)
                .await?;
        if roles.iter().filter(|r| owner(r)).count() <= 1 {
            return Err(StoreError::Conflict);
        }
    }
    tx.prepare().await?;
    let result = if let Some(role) = new_role {
        sqlx::query_as::<_, Member>("UPDATE member SET role=$1 WHERE id=$2 RETURNING *")
            .bind(role)
            .bind(&member.id)
            .fetch_one(&mut *tx)
            .await?
    } else {
        sqlx::query("DELETE FROM member WHERE id=$1")
            .bind(&member.id)
            .execute(&mut *tx)
            .await?;
        // Clear this user's active selection only; live membership checks deny
        // all of their other sessions immediately, without retaining authority.
        if member.user_id == live.user_id
            && let Authentication::Session { session_id } = &live.authentication
        {
            sqlx::query("UPDATE session SET active_organization_id=NULL WHERE id=$1 AND active_organization_id=$2").bind(session_id).bind(&live.workspace_id).execute(&mut *tx).await?;
        }
        member
    };
    tx.commit().await?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invite {
    pub email: String,
    pub role: String,
    #[serde(default)]
    pub resend: bool,
}

pub async fn invite(
    database: &Database,
    actor: &Actor,
    input: &Invite,
) -> Result<Invitation, StoreError> {
    let email = input.email.to_lowercase();
    if !forge_identity::valid_email(&email)
        || !["owner", "admin", "member"].contains(&input.role.as_str())
    {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, true).await?;
    let live = security::authorize(&mut tx, actor, SecurityAction::MembersInvite).await?;
    // Better Auth's organization ACL applies in addition to Forge's policy.
    if !live.has_role(&["owner", "admin"])
        || (input.role == "owner" && !owner(&live.workspace_role))
    {
        return Err(StoreError::Forbidden);
    }
    let existing:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM member m JOIN \"user\" u ON u.id=m.user_id WHERE m.organization_id=$1 AND lower(u.email)=$2)").bind(&live.workspace_id).bind(&email).fetch_one(&mut *tx).await?;
    if existing {
        return Err(StoreError::Conflict);
    }
    let prior=sqlx::query_as::<_,Invitation>("SELECT * FROM invitation WHERE organization_id=$1 AND email=$2 AND status='pending' AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR UPDATE").bind(&live.workspace_id).bind(&email).fetch_optional(&mut *tx).await?;
    let invitation = if let Some(prior) = prior {
        if !input.resend {
            return Err(StoreError::Conflict);
        }
        tx.prepare().await?;
        sqlx::query_as::<_,Invitation>("UPDATE invitation SET expires_at=clock_timestamp()+interval '48 hours' WHERE id=$1 RETURNING *").bind(&prior.id).fetch_one(&mut *tx).await?
    } else {
        let pending:i64=sqlx::query_scalar("SELECT count(*) FROM invitation WHERE organization_id=$1 AND status='pending' AND expires_at>clock_timestamp()").bind(&live.workspace_id).fetch_one(&mut *tx).await?;
        if pending >= 100 {
            return Err(StoreError::Conflict);
        }
        sqlx::query_as::<_,Invitation>("INSERT INTO invitation(id,organization_id,email,role,status,expires_at,inviter_id) VALUES($1,$2,$3,$4,'pending',clock_timestamp()+interval '48 hours',$5) RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(&live.workspace_id).bind(email).bind(&input.role).bind(&live.user_id).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(invitation)
}

pub async fn cancel_invitation(
    database: &Database,
    actor: &Actor,
    id: &str,
) -> Result<Invitation, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, true).await?;
    let live = current_actor(&mut tx, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. })
        || !live.has_role(&["owner", "admin"])
    {
        return Err(StoreError::Forbidden);
    }
    tx.prepare().await?;
    let row = sqlx::query_as::<_, Invitation>(
        "UPDATE invitation SET status='canceled' WHERE id=$1 AND organization_id=$2 RETURNING *",
    )
    .bind(id)
    .bind(&live.workspace_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    tx.commit().await?;
    Ok(row)
}
