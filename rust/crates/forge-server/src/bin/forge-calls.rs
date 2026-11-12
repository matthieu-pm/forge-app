//! Explicit native calls worker; environment only, without dotenv or scheduler changes.
use forge_server::{call_providers, operator};
use forge_store::{Database, calls::Report};
use std::{collections::HashMap, sync::Arc};
async fn run() -> Result<Report, &'static str> {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["run"] {
        return Err("INVALID_COMMAND");
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    call_providers::validate_operator(&env)?;
    let settings =
        call_providers::Settings::configured(&env).map_err(|_| "INVALID_CONFIGURATION")?;
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
        .connect(operator::database_url(&env)?)
        .await
        .map_err(|_| "CALL_SYNC_FAILED")?;
    let database = if let Some(journal) = journal {
        Database::with_journal(pool.clone(), Arc::new(journal), store_id)
    } else {
        Database::new(pool.clone())
    };
    let result = settings
        .service(database)
        .run()
        .await
        .map_err(|_| "CALL_SYNC_FAILED");
    pool.close().await;
    result
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(report) => {
            let success = report.failures == 0;
            println!(
                "{}",
                serde_json::json!({"job":"calls.sync","report":report})
            );
            if success {
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
