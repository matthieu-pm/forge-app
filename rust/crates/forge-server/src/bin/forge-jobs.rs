//! Explicit operator entry point. Never loads local dotenv or invents a target.
use forge_store::{
    Database,
    jobs::{Code, Error, JobStore, cli},
};
use std::sync::Arc;

async fn run() -> Result<serde_json::Value, Error> {
    let connection = std::env::var("DATABASE_URL").map_err(|_| Code::InvalidInput)?;
    let environment = std::env::var("FORGE_ENVIRONMENT").map_err(|_| Code::InvalidInput)?;
    if !["development", "staging", "production"].contains(&environment.as_str())
        || (environment == "development"
            && ["NODE_ENV", "VERCEL_ENV"]
                .iter()
                .any(|k| std::env::var(k).as_deref() == Ok("production")))
    {
        return Err(Code::InvalidInput.into());
    }
    let url = url::Url::parse(&connection).map_err(|_| Code::InvalidInput)?;
    if !["postgres", "postgresql"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.path().len() <= 1
    {
        return Err(Code::InvalidInput.into());
    }
    forge_core::features::FeatureRollouts::parse(
        std::env::var("FORGE_FEATURE_ROLLOUTS").ok().as_deref(),
    )
    .map_err(|_| Code::InvalidInput)?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&connection)
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
