use crate::{Database, StoreError, accounts::session_user_tx};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTicket {
    pub user_id: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    pub state: String,
}

pub async fn issue(
    database: &Database,
    session_token: &str,
    code: &str,
    state: &str,
    challenge: &str,
) -> Result<(), StoreError> {
    let mut tx = database.begin().await?;
    let (_, user) = session_user_tx(&mut tx, session_token).await?;
    let value = TransferTicket {
        user_id: user.id,
        code_challenge: challenge.into(),
        code_challenge_method: "s256".into(),
        state: state.into(),
    };
    sqlx::query("INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes')")
        .bind(Uuid::new_v4().to_string()).bind(format!("electron:{code}")).bind(serde_json::to_string(&value).map_err(|_|StoreError::InvalidInput)?).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn consume(database: &Database, code: &str) -> Result<TransferTicket, StoreError> {
    let mut tx = database.begin().await?;
    let identifier = format!("electron:{code}");
    let rows:Vec<(String,)> = sqlx::query_as("SELECT value FROM verification WHERE identifier=$1 AND expires_at>clock_timestamp() ORDER BY id LIMIT 2 FOR UPDATE").bind(&identifier).fetch_all(&mut *tx).await?;
    if rows.len() != 1 {
        return Err(StoreError::Forbidden);
    }
    let ticket = serde_json::from_str(&rows[0].0).map_err(|_| StoreError::Forbidden)?;
    tx.prepare().await?;
    sqlx::query("DELETE FROM verification WHERE identifier=$1")
        .bind(identifier)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ticket)
}
