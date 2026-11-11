use forge_agent_runtime::{
    Error, Result, configuration::ConfiguredFactory, host::Host, http, journal::Store,
    worker::Options,
};
use sqlx::postgres::PgPoolOptions;
use std::{collections::HashMap, sync::Arc, time::Duration};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--help"] || args == ["-h"] {
        println!(
            "forge-agent-runtime [serve|migrate]\nserve: start the native runtime without changing its schema\nmigrate: explicitly install/verify the private runtime journal schema"
        );
        return Ok(());
    }
    if !args.is_empty() && args != ["serve"] && args != ["migrate"] {
        return Err(Error("Expected serve, migrate or --help."));
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let url = env
        .get("FORGE_RUST_RUNTIME_DATABASE_URL")
        .filter(|v| !v.is_empty())
        .ok_or(Error("FORGE_RUST_RUNTIME_DATABASE_URL is required."))?;
    let pool = tokio::time::timeout(
        Duration::from_secs(10),
        PgPoolOptions::new()
            .max_connections(32)
            .acquire_timeout(Duration::from_secs(5))
            .connect(url),
    )
    .await
    .map_err(|_| Error("The private runtime database is unavailable."))?
    .map_err(|_| Error("The private runtime database is unavailable."))?;
    if args == ["migrate"] {
        Store::install(&pool).await?;
        println!("Private native runtime schema verified.");
        return Ok(());
    }
    Store::verify(&pool).await?;
    let secret = env
        .get("FORGE_AGENT_CHANNEL_SECRET")
        .cloned()
        .ok_or(Error("FORGE_AGENT_CHANNEL_SECRET is required."))?;
    let factory = Arc::new(ConfiguredFactory::new(&env)?);
    let host = Host::new(Store::new(pool), factory, Options::default(), 32, 128)?;
    let app = http::router(host.clone(), secret)?;
    let bind = env
        .get("FORGE_RUST_RUNTIME_BIND")
        .map(String::as_str)
        .unwrap_or("127.0.0.1:3101");
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|_| Error("The native runtime listener is unavailable."))?;
    println!(
        "Native runtime listening on {}",
        listener
            .local_addr()
            .map_err(|_| Error("The native runtime listener is unavailable."))?
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = host.shutdown().await;
        })
        .await
        .map_err(|_| Error("The native runtime HTTP service failed."))
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
