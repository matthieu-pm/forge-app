use std::net::SocketAddr;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = std::env::var("FORGE_RUST_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3100".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!(
        "Forge Rust {} listening on {}",
        forge_core::VERSION,
        listener.local_addr()?
    );
    axum::serve(listener, forge_server::router())
        .with_graceful_shutdown(async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                eprintln!("Unable to install shutdown signal handler: {error}");
            }
        })
        .await?;
    Ok(())
}
