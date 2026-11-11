//! Explicitly selected native invitation worker. No dotenv or cron registration.
use forge_server::{invitation_workflow::MailTransport, mail::ResendMailer, operator};
use forge_store::{
    Database,
    jobs::{JobStore, invitations},
};
use std::{collections::HashMap, sync::Arc};
async fn run() -> Result<serde_json::Value, &'static str> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let id = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["run"] => None,
        ["run", id] => Some(uuid::Uuid::parse_str(id).map_err(|_| "INVALID_COMMAND")?),
        _ => return Err("INVALID_COMMAND"),
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    let connection = operator::database_url(&env)?;
    let mailer = ResendMailer::from_environment()
        .map_err(|_| "INVALID_CONFIGURATION")?
        .ok_or("INVALID_CONFIGURATION")?;
    let transport = MailTransport::new(
        Arc::new(mailer),
        env.get("BETTER_AUTH_URL").ok_or("INVALID_CONFIGURATION")?,
    )?;
    let journal =
        forge_recovery::R2Journal::from_environment().map_err(|_| "INVALID_CONFIGURATION")?;
    let store_id = if journal.is_some() {
        env.get("BLOB_STORE_ID")
            .filter(|s| !s.is_empty())
            .ok_or("INVALID_CONFIGURATION")?
            .clone()
    } else {
        String::new()
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(connection)
        .await
        .map_err(|_| "INVITATION_WORKER_FAILED")?;
    let database = if let Some(journal) = journal {
        Database::with_journal(pool.clone(), Arc::new(journal), store_id)
    } else {
        Database::new(pool.clone())
    };
    let result = invitations::run_next(&JobStore::new(database), &transport, id)
        .await
        .map_err(|_| "INVITATION_WORKER_FAILED");
    pool.close().await;
    result
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(result) => {
            println!("{result}");
            if ["idle", "completed", "deferred"]
                .iter()
                .any(|state| result["state"] == *state)
            {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            }
        }
        Err(code) => {
            eprintln!("{}", serde_json::json!({"code":code}));
            std::process::ExitCode::FAILURE
        }
    }
}
