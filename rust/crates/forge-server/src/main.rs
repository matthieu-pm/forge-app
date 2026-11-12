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
        let mut settings = AuthSettings::new(secret, &url)?;
        if let Ok(secret) = std::env::var("FORGE_INVITE_LINK_SECRET") {
            settings = settings.with_invite_secret(secret)?;
        }
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
        let storage = forge_server::files::storage::Storage::from_environment()?;
        let grant_secret = std::env::var("FORGE_AGENT_ARTIFACT_SECRET")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| std::env::var("FORGE_AGENT_CAPABILITY_SECRET").ok())
            .unwrap_or_default();
        let environment = std::env::vars().collect();
        let model_proxy =
            forge_server::model_proxy::Settings::configured(database.clone(), &environment);
        let agents = forge_server::agents::Settings::configured(
            database.clone(),
            storage.clone(),
            &environment,
        )?;
        let billing = forge_server::billing::Settings::configured(database.clone(), &environment)?;
        let state = AppState::configured_database(database, settings, mailer)
            .with_billing(billing)
            .with_calls(forge_server::call_providers::Settings::configured(
                &environment,
            )?)
            .with_model_proxy(model_proxy)
            .with_agents(agents)
            .with_files(storage, grant_secret)
            .with_profile_editing(
                std::env::var("FORGE_PROFILE_EDITING_ENABLED").as_deref() == Ok("true"),
            )
            .with_issue_retention(
                std::env::var("FORGE_ISSUE_RETENTION_ENABLED").as_deref() == Ok("true"),
                std::env::var("FORGE_ISSUE_RETENTION_SECRET").unwrap_or_default(),
            )
            .with_sla_scheduler(
                std::env::var("FORGE_SLA_JOBS_ENABLED").as_deref() == Ok("true"),
                std::env::var("CRON_SECRET").unwrap_or_default(),
            );
        if let Some(client) = forge_server::oauth_provider::ChatGptClient::from_environment()
            .map_err(|_| "OAuth configuration is invalid.")?
        {
            state.with_chatgpt(client)
        } else {
            state
        }
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
