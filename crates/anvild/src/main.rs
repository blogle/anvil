use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anvild::engine::{Engine, EngineConfig};
use anvild::github::GithubClient;
use anvild::harness::{Harness, OpencodeHarness};
use anvild::http;
use anvild::sandbox::PodmanProvider;
use anvild::store::Store;
use tokio::sync::watch;

fn main() -> ExitCode {
    if let Ok(path) = dotenvy::dotenv() {
        eprintln!("anvild: loaded {}", path.display());
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("anvild: could not start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(daemon())
}

async fn daemon() -> ExitCode {
    let db = value_of("db")
        .or_else(|| std::env::var("ANVIL_DB").ok())
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
            format!("{home}/.local/state/anvil/anvil.db")
        });
    let db = PathBuf::from(db);
    if let Some(parent) = db.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            eprintln!(
                "anvild: cannot create the state directory: {}",
                parent.display()
            );
            return ExitCode::FAILURE;
        }
    }

    let store = match Store::open(&db).await {
        Ok(store) => store,
        Err(error) => {
            eprintln!("anvild: cannot open the store at {}: {error}", db.display());
            return ExitCode::FAILURE;
        }
    };

    match store.close_in_flight_turns().await {
        Ok(0) => {}
        Ok(count) => {
            eprintln!("anvild: closed {count} turn(s) left in flight by a previous boot")
        }
        Err(error) => {
            eprintln!("anvild: cannot close in-flight turns: {error}");
            return ExitCode::FAILURE;
        }
    }

    let bind = value_of("bind")
        .or_else(|| std::env::var("ANVIL_BIND").ok())
        .unwrap_or_else(|| "127.0.0.1:8788".to_owned());

    let advertise_port = bind
        .rsplit(':')
        .next()
        .filter(|port| port.parse::<u16>().is_ok())
        .unwrap_or("8788");
    let daemon_url = std::env::var("ANVIL_ADVERTISE_URL")
        .unwrap_or_else(|_| format!("http://10.0.2.2:{advertise_port}"));

    let config = EngineConfig {
        daemon_url,
        ..EngineConfig::default()
    };

    let mut engine = Engine::new(store.clone(), config);
    if let Some(github) = github_from_credentials(&store).await {
        engine = engine.with_github(github);
    }
    if let Ok(runtime) = std::env::var("ANVIL_SANDBOX") {
        if runtime != "podman" {
            eprintln!("anvild: unsupported ANVIL_SANDBOX={runtime}; use podman or unset it");
            return ExitCode::FAILURE;
        }
    }
    let sandbox = PodmanProvider::default();
    engine = engine
        .with_sandbox(Arc::new(sandbox))
        .with_harness(Arc::new(Harness::Opencode(OpencodeHarness::new())));
    let (shutdown, shutdown_rx) = watch::channel(false);
    tokio::spawn(engine.run(shutdown_rx));

    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(listener) => listener,
        Err(error) => {
            let _ = shutdown.send(true);
            eprintln!("anvild: cannot bind {bind}: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!("anvild: serving on {bind}");

    match axum::serve(listener, http::router(store)).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("anvild: the http server failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn github_from_credentials(store: &Store) -> Option<GithubClient> {
    let app_id = store.credential("github-app-id").await.ok()??;
    let installation = store.credential("github-installation-id").await.ok()??;
    let key = store.credential("github-app-private-key").await.ok()??;
    let Ok(installation) = installation.trim().parse::<i64>() else {
        eprintln!("anvild: github-installation-id is not a number");
        return None;
    };
    match GithubClient::new("https://api.github.com", app_id, installation, &key) {
        Ok(client) => Some(client),
        Err(error) => {
            eprintln!("anvild: the stored github app key is unusable: {error}");
            None
        }
    }
}

fn value_of(name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}
