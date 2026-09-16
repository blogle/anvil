use anvild::{router, AppState, Config, KubeSandboxApi};
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let config = Config::from_env()?;
    let state = AppState::new(config.clone(), KubeSandboxApi::new(config).await?);
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], state.config.bind_port)))
            .await?;
    axum::serve(listener, router(state)).await?;
    Ok(())
}
