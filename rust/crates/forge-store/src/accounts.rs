//! Account/session persistence. Callers validate inputs and perform password
//! hashing outside the async executor before opening these transactions.

use crate::StoreError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub image: Option<String>,
    pub username: Option<String>,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub token: String,
    pub user_id: String,
    pub active_organization_id: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
}

pub struct Registration {
    pub user: User,
    pub created: bool,
}

pub async fn register_email_user(
    pool: &crate::Database,
    name: &str,
    email: &str,
    image: Option<&str>,
    password_hash: &str,
) -> Result<Registration, StoreError> {
    let mut tx = pool.begin().await?;
    let id = Uuid::new_v4().to_string();
    let user = sqlx::query_as::<_, User>("INSERT INTO \"user\"(id,name,email,email_verified,image) VALUES($1,$2,$3,false,$4) ON CONFLICT(email) DO NOTHING RETURNING *")
        .bind(&id).bind(name).bind(email).bind(image).fetch_optional(&mut *tx).await?;
    let Some(user) = user else {
        // Verification-required signup deliberately does not reveal existing users.
        let now = Utc::now();
        return Ok(Registration {
            user: User {
                id,
                name: name.into(),
                email: email.into(),
                email_verified: false,
                image: image.map(str::to_owned),
                username: None,
                title: None,
                created_at: now,
                updated_at: now,
            },
            created: false,
        });
    };
    sqlx::query("INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)")
        .bind(Uuid::new_v4().to_string()).bind(&user.id).bind(password_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Registration {
        user,
        created: true,
    })
}

pub async fn credential_account(
    pool: &crate::Database,
    email: &str,
) -> Result<Option<(User, String)>, StoreError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE email=$1")
        .bind(email)
        .fetch_optional(pool.pool())
        .await?;
    let Some(user) = user else { return Ok(None) };
    let password: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT password FROM account WHERE user_id=$1 AND provider_id='credential'",
    )
    .bind(&user.id)
    .fetch_optional(pool.pool())
    .await?;
    Ok(password
        .and_then(|(password,)| password)
        .map(|password| (user, password)))
}

pub async fn user_by_email(
    pool: &crate::Database,
    email: &str,
) -> Result<Option<User>, StoreError> {
    Ok(
        sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE email=$1")
            .bind(email)
            .fetch_optional(pool.pool())
            .await?,
    )
}

pub async fn create_session(
    pool: &crate::Database,
    user_id: &str,
    token: &str,
    remember: bool,
    user_agent: Option<&str>,
) -> Result<Session, StoreError> {
    let mut tx = pool.begin().await?;
    let verified: Option<(bool,)> =
        sqlx::query_as("SELECT email_verified FROM \"user\" WHERE id=$1 FOR SHARE")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if verified != Some((true,)) {
        return Err(StoreError::EmailNotVerified);
    }
    let session = sqlx::query_as::<_, Session>("INSERT INTO session(id,token,user_id,expires_at,user_agent) VALUES($1,$2,$3,clock_timestamp()+make_interval(secs=>$4),$5) RETURNING *")
        .bind(Uuid::new_v4().to_string()).bind(token).bind(user_id).bind(if remember { 604800.0f64 } else { 86400.0f64 }).bind(user_agent).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(session)
}

pub async fn session_and_user(
    pool: &crate::Database,
    token: &str,
    refresh: bool,
    remember: bool,
) -> Result<Option<(Session, User)>, StoreError> {
    let mut tx = pool.begin().await?;
    let session = sqlx::query_as::<_, Session>(
        "SELECT * FROM session WHERE token=$1 AND expires_at>clock_timestamp() FOR UPDATE",
    )
    .bind(token)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(mut session) = session else {
        return Ok(None);
    };
    let user = sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE id=$1")
        .bind(&session.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if refresh && remember && needs_refresh(&session) {
        tx.prepare().await?;
        session = sqlx::query_as::<_, Session>("UPDATE session SET expires_at=clock_timestamp()+interval '7 days',updated_at=clock_timestamp() WHERE id=$1 RETURNING *")
            .bind(&session.id).fetch_one(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Some((session, user)))
}

pub fn needs_refresh(session: &Session) -> bool {
    session.expires_at - chrono::Duration::days(7) + chrono::Duration::seconds(60) <= Utc::now()
}

pub async fn verify_email(pool: &crate::Database, email: &str) -> Result<bool, StoreError> {
    let mut tx = pool.begin().await?;
    let verified: Option<(bool,)> =
        sqlx::query_as("SELECT email_verified FROM \"user\" WHERE email=$1 FOR UPDATE")
            .bind(email)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((verified,)) = verified else {
        return Ok(false);
    };
    if !verified {
        tx.prepare().await?;
        sqlx::query(
            "UPDATE \"user\" SET email_verified=true,updated_at=clock_timestamp() WHERE email=$1",
        )
        .bind(email)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn sign_out(pool: &crate::Database, token: &str) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    tx.prepare().await?;
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(token)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn list_sessions(
    pool: &crate::Database,
    token: &str,
) -> Result<Vec<Session>, StoreError> {
    let mut tx = pool.begin().await?;
    let identity: Option<(String,)> = sqlx::query_as(
        "SELECT user_id FROM session WHERE token=$1 AND expires_at>clock_timestamp() FOR SHARE",
    )
    .bind(token)
    .fetch_optional(&mut *tx)
    .await?;
    let (user_id,) = identity.ok_or(StoreError::Unauthenticated)?;
    let sessions = sqlx::query_as::<_, Session>(
        "SELECT * FROM session WHERE user_id=$1 AND expires_at>clock_timestamp()",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(sessions)
}

pub async fn revoke_session(
    pool: &crate::Database,
    current_token: &str,
    target_token: &str,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    // Lock both rows in a consistent order when two sessions revoke each other.
    let rows = sqlx::query_as::<_, Session>("SELECT * FROM session WHERE token IN ($1,$2) AND expires_at>clock_timestamp() ORDER BY id FOR UPDATE")
        .bind(current_token).bind(target_token).fetch_all(&mut *tx).await?;
    let user_id = &rows
        .iter()
        .find(|session| session.token == current_token)
        .ok_or(StoreError::Unauthenticated)?
        .user_id;
    tx.prepare().await?;
    sqlx::query("DELETE FROM session WHERE user_id=$1 AND token=$2")
        .bind(user_id)
        .bind(target_token)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn session_user_tx(
    connection: &mut sqlx::PgConnection,
    token: &str,
) -> Result<(Session, User), StoreError> {
    let session = sqlx::query_as::<_, Session>(
        "SELECT * FROM session WHERE token=$1 AND expires_at>clock_timestamp() FOR UPDATE",
    )
    .bind(token)
    .fetch_optional(&mut *connection)
    .await?
    .ok_or(StoreError::Unauthenticated)?;
    let user = sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE id=$1 FOR SHARE")
        .bind(&session.user_id)
        .fetch_one(connection)
        .await?;
    if !user.email_verified {
        return Err(StoreError::EmailNotVerified);
    }
    Ok((session, user))
}
