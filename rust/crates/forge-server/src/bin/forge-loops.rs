//! Explicit native loop worker. Configuration comes from the process environment;
//! no dotenv files or scheduler registrations are read or changed.
use forge_server::{agents, files::storage::Storage, operator};
use forge_store::{
    Database,
    loops::{DispatchOptions, DispatchReport, Options, Service},
};
use std::{collections::HashMap, sync::Arc, time::Duration};

async fn run() -> Result<(), &'static str> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let watch = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["run"] => false,
        ["run", "--watch"] => true,
        _ => return Err("INVALID_COMMAND"),
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    let options = Options::from_environment(env.clone());
    if !options.enabled {
        receipt(DispatchReport::default());
        return Ok(());
    }
    let connection = operator::database_url(&env)?;
    let storage = Storage::from_config(&env).map_err(|_| "INVALID_CONFIGURATION")?;
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
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| "LOOP_DISPATCH_FAILED")?;
    let (shutdown_tx, mut shutdown) = tokio::sync::watch::channel(false);
    let signals = tokio::spawn(async move {
        #[cfg(unix)]
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        let _ = shutdown_tx.send(true);
    });
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(connection)
        .await
        .map_err(|_| "LOOP_DISPATCH_FAILED")?;
    let result = async {
        let database = if let Some(journal) = journal {
            Database::with_journal(pool.clone(), Arc::new(journal), store_id)
        } else {
            Database::new(pool.clone())
        };
        let agents = agents::Settings::configured(database.clone(), storage, &env)
            .map_err(|_| "INVALID_CONFIGURATION")?;
        let mut service = Service::new(database, options);
        service.agents = Some(Arc::new(agents.coordinator));
        loop {
            // Signals stop the next claim, never discard an active execution.
            if *shutdown.borrow() {
                break;
            }
            let result = service
                .dispatch(DispatchOptions {
                    limit: 1,
                    ..Default::default()
                })
                .await
                .map_err(|_| "LOOP_DISPATCH_FAILED")?;
            receipt(result);
            if !watch || !result.enabled || *shutdown.borrow() {
                break;
            }
            if result.executed == 0 {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                    _ = shutdown.changed() => {},
                }
            }
        }
        Ok(())
    }
    .await;
    signals.abort();
    pool.close().await;
    result
}
fn receipt(report: DispatchReport) {
    println!(
        "{}",
        serde_json::json!({"job":"loops.dispatch","enabled":report.enabled,
        "events":report.events,"scheduled":report.scheduled,"executed":report.executed})
    );
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(code) => {
            eprintln!("{}", serde_json::json!({"code":code}));
            std::process::ExitCode::FAILURE
        }
    }
}
