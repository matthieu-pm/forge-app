//! Scheduled, explicitly configured retention. No cron registration or dotenv.
use forge_core::files::upload;
use forge_server::{
    files::storage::{Inspector, Storage},
    operator,
};
use forge_store::{
    Database,
    agents::{
        files::Service,
        retention::{self, Report},
    },
};
use std::{collections::HashMap, sync::Arc};
async fn run() -> Result<Report, &'static str> {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["agent"] {
        return Err("INVALID_COMMAND");
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let connection = operator::database_url(&env)?;
    let storage = Storage::from_config(&env).map_err(|_| "INVALID_CONFIGURATION")?;
    let journal =
        forge_recovery::R2Journal::from_environment().map_err(|_| "INVALID_CONFIGURATION")?;
    let store_id = if journal.is_some() {
        env.get("BLOB_STORE_ID")
            .filter(|v| !v.is_empty())
            .ok_or("INVALID_CONFIGURATION")?
            .clone()
    } else {
        String::new()
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(connection)
        .await
        .map_err(|_| "RETENTION_FAILED")?;
    let database = if let Some(journal) = journal {
        Database::with_journal(pool.clone(), Arc::new(journal), store_id)
    } else {
        Database::new(pool.clone())
    };
    let files = Service::new(database.clone(), Arc::new(storage.clone()));
    let uploads = upload::Service {
        store: Arc::new(forge_store::files::UploadStore::new(database)),
        transport: Arc::new(storage),
        inspector: Arc::new(Inspector),
    };
    let result = retention::run(&files, &uploads, chrono::Utc::now())
        .await
        .map_err(|_| "RETENTION_FAILED");
    pool.close().await;
    result
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(report) => {
            println!(
                "{}",
                serde_json::json!({"job":"agent.retention","count":report.count,"failures":report.failures})
            );
            if report.successful() {
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
