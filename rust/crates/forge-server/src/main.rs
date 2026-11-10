use forge_server::{
    mail::ResendMailer,
    state::{AppState, AuthSettings},
};
use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = std::env::var("FORGE_RUST_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3100".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let state = if let Ok(connection) = std::env::var("DATABASE_URL") {
        let secret = std::env::var("BETTER_AUTH_SECRET")
            .map_err(|_| "BETTER_AUTH_SECRET is required when DATABASE_URL is configured.")?;
        let url = std::env::var("BETTER_AUTH_URL")
            .map_err(|_| "BETTER_AUTH_URL is required when DATABASE_URL is configured.")?;
        let settings = AuthSettings::new(secret, &url)?;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(20)
            .connect_lazy(&connection)?;
        let mailer = ResendMailer::from_environment()
            .map_err(|_| "Email configuration is invalid.")?
            .map(|mailer| Arc::new(mailer) as Arc<dyn forge_server::mail::VerificationMailer>);
        let database = if let Some(journal) = forge_recovery::R2Journal::from_environment()
            .map_err(|_| "Recovery journal configuration is invalid.")?
        {
            let store_id = std::env::var("BLOB_STORE_ID")
                .map_err(|_| "BLOB_STORE_ID is required for the recovery journal.")?;
            forge_store::Database::with_journal(pool, Arc::new(journal), store_id)
        } else {
            forge_store::Database::new(pool)
        };
        AppState::configured_database(database, settings, mailer)
    } else {
        AppState::default()
    };
    eprintln!(
        "Forge Rust {} listening on {}",
        forge_core::VERSION,
        listener.local_addr()?
    );
    axum::serve(
        listener,
        forge_server::router_with_state(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("Unable to install shutdown signal handler: {error}");
        }
    })
    .await?;
    Ok(())
}
