use anvil_router::{run, Config};

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    run(Config::from_env()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?)
    .await
}
