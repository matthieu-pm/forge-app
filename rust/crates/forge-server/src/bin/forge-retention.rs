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
async fn run() -> Result<(&'static str, Report), &'static str> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let kind = match args.as_slice() {
        [kind] if kind == "agent" => "agent.retention",
        [kind] if kind == "product" => "product.retention",
        _ => return Err("INVALID_COMMAND"),
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    let connection = operator::database_url(&env)?;
    let storage = Storage::from_config(&env).map_err(|_| "INVALID_CONFIGURATION")?;
    let desktop = if kind == "product.retention" {
        forge_server::desktop_retention::Storage::configured(&env)?
    } else {
        None
    };
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
    let now =
        chrono::DateTime::from_timestamp_millis(chrono::Utc::now().timestamp_millis()).unwrap();
    let result = if kind == "agent.retention" {
        let files = Service::new(database.clone(), Arc::new(storage.clone()));
        let uploads = upload::Service {
            store: Arc::new(forge_store::files::UploadStore::new(database)),
            transport: Arc::new(storage),
            inspector: Arc::new(Inspector),
        };
        retention::run(&files, &uploads, now)
            .await
            .map_err(|_| "RETENTION_FAILED")
    } else {
        forge_store::retention::run_product(
            &database,
            &storage,
            desktop
                .as_ref()
                .map(|v| v as &dyn forge_store::retention::DesktopBlobs),
            env.get("FORGE_RECOVERY_JOURNAL_ENABLED")
                .is_some_and(|v| v == "true"),
            now,
        )
        .await
        .map_err(|_| "RETENTION_FAILED")
    };
    pool.close().await;
    result.map(|report| (kind, report))
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok((kind, report)) => {
            println!(
                "{}",
                serde_json::json!({"job":kind,"count":report.count,"failures":report.failures})
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
