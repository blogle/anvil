use anvilctl::{run, Cli};
use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run(Cli::parse()).await
}
