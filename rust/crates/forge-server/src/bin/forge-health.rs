//! Scheduled health checks use only the explicit database target. No dotenv,
//! provider credentials, lease recovery, invitation delivery or scheduler setup.
use forge_server::operator;
use forge_store::{Database, operational_health};
async fn run() -> Result<operational_health::Report, &'static str> {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["workflows"] {
        return Err("INVALID_COMMAND");
    }
    let env = std::env::vars().collect();
    let connection = operator::database_url(&env)?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(connection)
        .await
        .map_err(|_| "WORKFLOW_HEALTH_FAILED")?;
    let now =
        chrono::DateTime::from_timestamp_millis(chrono::Utc::now().timestamp_millis()).unwrap();
    let result = operational_health::workflows(&Database::new(pool.clone()), now)
        .await
        .map_err(|_| "WORKFLOW_HEALTH_FAILED");
    pool.close().await;
    result
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(report) => {
            let successful = report.successful();
            println!(
                "{}",
                serde_json::json!({"job":"workflow.health","report":report})
            );
            if successful {
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
