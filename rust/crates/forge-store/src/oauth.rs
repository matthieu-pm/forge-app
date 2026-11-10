use crate::{
    Database, StoreError,
    accounts::{Session, User, session_user_tx},
};
use chrono::Utc;
use forge_identity::SocialIdentity;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    pub user_id: String,
    pub email: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct OAuthTicket {
    #[serde(rename = "callbackURL")]
    pub callback_url: String,
    #[serde(rename = "codeVerifier")]
    pub code_verifier: String,
    #[serde(rename = "errorURL")]
    pub error_url: Option<String>,
    #[serde(rename = "newUserURL")]
    pub new_user_url: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(rename = "oauthState", default)]
    pub oauth_state: Option<String>,
    pub link: Option<LinkTarget>,
}

pub async fn save_ticket(
    database: &Database,
    state: &str,
    ticket: &OAuthTicket,
) -> Result<(), StoreError> {
    if state.is_empty()
        || state.len() > 512
        || ticket.oauth_state.as_deref() != Some(state)
        || ticket.expires_at <= Utc::now().timestamp_millis()
    {
        return Err(StoreError::InvalidInput);
    }
    let expires_at = chrono::DateTime::from_timestamp_millis(ticket.expires_at)
        .ok_or(StoreError::InvalidInput)?;
    sqlx::query("INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)")
        .bind(Uuid::new_v4().to_string())
        .bind(state)
        .bind(serde_json::to_string(ticket).map_err(|_| StoreError::InvalidInput)?)
        .bind(expires_at)
        .execute(database.pool())
        .await?;
    Ok(())
}

#[derive(FromRow)]
struct Verification {
    value: String,
}

pub async fn consume_ticket(database: &Database, state: &str) -> Result<OAuthTicket, StoreError> {
    let mut tx = database.begin().await?;
    let rows=sqlx::query_as::<_,Verification>("SELECT value FROM verification WHERE identifier=$1 AND expires_at>clock_timestamp() ORDER BY id LIMIT 2 FOR UPDATE")
        .bind(state).fetch_all(&mut *tx).await?;
    if rows.len() != 1 {
        return Err(StoreError::Forbidden);
    }
    let ticket: OAuthTicket =
        serde_json::from_str(&rows[0].value).map_err(|_| StoreError::Forbidden)?;
    if ticket.expires_at < Utc::now().timestamp_millis()
        || ticket
            .oauth_state
            .as_ref()
            .is_some_and(|saved| saved != state)
    {
        return Err(StoreError::Forbidden);
    }
    tx.prepare().await?;
    sqlx::query("DELETE FROM verification WHERE identifier=$1")
        .bind(state)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ticket)
}

pub struct SocialLogin {
    pub user: User,
    pub session: Option<Session>,
    pub new_user: bool,
}

pub async fn finish_social_login(
    database: &Database,
    account_id: &str,
    identity: &SocialIdentity,
    new_session_token: &str,
    link: Option<&LinkTarget>,
    current_session_token: Option<&str>,
) -> Result<SocialLogin, StoreError> {
    let email = identity
        .email
        .as_deref()
        .ok_or(StoreError::InvalidInput)?
        .to_lowercase();
    let mut tx = database.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,84047861))")
        .bind(account_id)
        .execute(&mut *tx)
        .await?;
    let account: Option<(String,)> = sqlx::query_as(
        "SELECT user_id FROM account WHERE provider_id='chatgpt' AND account_id=$1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(link) = link {
        let (session, user) = session_user_tx(
            &mut tx,
            current_session_token.ok_or(StoreError::Unauthenticated)?,
        )
        .await?;
        if user.id != link.user_id
            || user.email.to_lowercase() != link.email.to_lowercase()
            || user.email.to_lowercase() != email
            || link.session_id.as_ref().is_some_and(|id| id != &session.id)
            || account.as_ref().is_some_and(|(id,)| id != &user.id)
        {
            return Err(StoreError::Forbidden);
        }
        if account.is_none() {
            sqlx::query(
                "INSERT INTO account(id,account_id,provider_id,user_id) VALUES($1,$2,'chatgpt',$3)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(account_id)
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        return Ok(SocialLogin {
            user,
            session: None,
            new_user: false,
        });
    }
    let new_user = account.is_none();
    let mut user = if let Some((user_id,)) = account {
        sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?
    } else {
        // Email matching alone never links an existing Forge account.
        let existing: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM \"user\" WHERE email=$1)")
                .bind(&email)
                .fetch_one(&mut *tx)
                .await?;
        if existing {
            return Err(StoreError::AccountNotLinked);
        }
        let user=sqlx::query_as::<_,User>("INSERT INTO \"user\"(id,name,email,email_verified,image) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(identity.name.as_deref().unwrap_or(&email)).bind(&email).bind(identity.email_verified).bind(&identity.image).fetch_optional(&mut *tx).await?.ok_or(StoreError::AccountNotLinked)?;
        sqlx::query(
            "INSERT INTO account(id,account_id,provider_id,user_id) VALUES($1,$2,'chatgpt',$3)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(account_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
        user
    };
    if !user.email_verified && identity.email_verified && user.email.to_lowercase() == email {
        tx.prepare().await?;
        user=sqlx::query_as::<_,User>("UPDATE \"user\" SET email_verified=true,updated_at=clock_timestamp() WHERE id=$1 RETURNING *").bind(&user.id).fetch_one(&mut *tx).await?;
    }
    let session = if user.email_verified {
        Some(sqlx::query_as::<_,Session>("INSERT INTO session(id,token,user_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days') RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(new_session_token).bind(&user.id).fetch_one(&mut *tx).await?)
    } else {
        None
    };
    tx.commit().await?;
    Ok(SocialLogin {
        user,
        session,
        new_user,
    })
}
