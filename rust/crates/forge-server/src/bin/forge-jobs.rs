//! Explicit operator entry point. Never loads local dotenv or invents a target.
use forge_store::{
    Database,
    jobs::{Code, Error, JobStore, cli},
};
use std::sync::Arc;

async fn run() -> Result<serde_json::Value, Error> {
    let env = std::env::vars().collect();
    let connection = forge_server::operator::database_url(&env).map_err(|_| Code::InvalidInput)?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(connection)
        .await
        .map_err(|_| Code::JobFailed)?;
    let journal = forge_recovery::R2Journal::from_environment().map_err(|_| Code::InvalidInput)?;
    let database = if let Some(journal) = journal {
        Database::with_journal(
            pool.clone(),
            Arc::new(journal),
            std::env::var("BLOB_STORE_ID").map_err(|_| Code::InvalidInput)?,
        )
    } else {
        Database::new(pool.clone())
    };
    let store = JobStore::new(database);
    let result = cli::command(
        &store,
        &std::env::args().skip(1).collect::<Vec<_>>(),
        chrono::Utc::now(),
    )
    .await;
    pool.close().await;
    result
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).expect("JSON result")
            );
            if result
                .get("state")
                .is_some_and(|s| s != "idle" && s != "completed")
            {
                std::process::ExitCode::FAILURE
            } else {
                std::process::ExitCode::SUCCESS
            }
        }
        Err(error) => {
            eprintln!("{}", serde_json::json!({"code":error.code}));
            std::process::ExitCode::FAILURE
        }
    }
}
