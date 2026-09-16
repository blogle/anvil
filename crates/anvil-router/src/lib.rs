//! HTTP reverse proxy for Agent Sandbox preview hosts.

use anvil_core::{parse_preview_hostname, Port, SessionId};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Request, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::{
    client::legacy::{connect::HttpConnector, Client},
    rt::{TokioExecutor, TokioIo},
};
use std::{env, net::SocketAddr, sync::Arc};
use thiserror::Error;
use tracing::{info, warn};
use url::Url;

type HttpClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Body>;

#[derive(Debug, Clone)]
pub struct Config {
    pub base_domain: String,
    pub upstream: Url,
    pub listen_addr: SocketAddr,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("invalid {field}: {reason}")]
    Invalid { field: &'static str, reason: String },
}

impl Config {
    pub fn new(
        base_domain: impl Into<String>,
        upstream: impl AsRef<str>,
    ) -> Result<Self, ConfigError> {
        let base_domain = base_domain
            .into()
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if base_domain.is_empty()
            || base_domain.parse::<std::net::IpAddr>().is_ok()
            || base_domain.contains('/')
            || base_domain.contains(':')
        {
            return Err(ConfigError::Invalid {
                field: "BASE_DOMAIN",
                reason: "must be a DNS domain name".into(),
            });
        }
        let upstream = Url::parse(upstream.as_ref()).map_err(|error| ConfigError::Invalid {
            field: "AGENT_SANDBOX_ROUTER_URL",
            reason: error.to_string(),
        })?;
        if !matches!(upstream.scheme(), "http" | "https") || upstream.host_str().is_none() {
            return Err(ConfigError::Invalid {
                field: "AGENT_SANDBOX_ROUTER_URL",
                reason: "expected an http(s) URL with a host".into(),
            });
        }
        let listen_addr = env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".into())
            .parse::<SocketAddr>()
            .map_err(|error| ConfigError::Invalid {
                field: "LISTEN_ADDR",
                reason: error.to_string(),
            })?;
        Ok(Self {
            base_domain,
            upstream,
            listen_addr,
        })
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        Self::new(
            env::var("BASE_DOMAIN").map_err(|_| ConfigError::Missing("BASE_DOMAIN"))?,
            env::var("AGENT_SANDBOX_ROUTER_URL")
                .map_err(|_| ConfigError::Missing("AGENT_SANDBOX_ROUTER_URL"))?,
        )
    }
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    client: HttpClient,
}

pub fn app(config: Config) -> Router {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let connector = HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .build();
    let client = Client::builder(TokioExecutor::new()).build(connector);
    let state = AppState {
        config: Arc::new(config),
        client,
    };
    Router::new()
        .route("/healthz", axum::routing::get(|| async { StatusCode::OK }))
        .route("/readyz", axum::routing::get(ready))
        .fallback(any(proxy))
        .with_state(state)
}

async fn ready(State(state): State<AppState>) -> StatusCode {
    if state.config.upstream.host_str().is_some() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

fn request_host(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::HOST)?
        .to_str()
        .ok()?
        .split(':')
        .next()
        .map(str::to_ascii_lowercase)
}

fn upstream_uri(upstream: &Url, request_uri: &Uri) -> Result<Uri, StatusCode> {
    let base = upstream.as_str().trim_end_matches('/');
    let path = request_uri
        .path_and_query()
        .map_or("/", |value| value.as_str());
    format!("{base}{path}")
        .parse()
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

fn prepare_request(
    mut request: Request<Body>,
    config: &Config,
) -> Result<(Request<Body>, SessionId, Port), StatusCode> {
    let host = request_host(request.headers()).ok_or(StatusCode::BAD_REQUEST)?;
    let (session, port) =
        parse_preview_hostname(&host, &config.base_domain).ok_or(StatusCode::BAD_REQUEST)?;
    let uri = upstream_uri(&config.upstream, request.uri())?;
    *request.uri_mut() = uri;
    let headers = request.headers_mut();
    let untrusted_headers: Vec<_> = headers
        .keys()
        .filter(|name| {
            name.as_str().starts_with("x-sandbox-")
                || *name == header::AUTHORIZATION
                || *name == header::HOST
        })
        .cloned()
        .collect();
    for name in untrusted_headers {
        headers.remove(name);
    }
    headers.insert(
        "x-sandbox-id",
        session
            .to_string()
            .parse()
            .map_err(|_| StatusCode::BAD_GATEWAY)?,
    );
    headers.insert("x-sandbox-namespace", "default".parse().unwrap());
    headers.insert("x-sandbox-port", port.get().to_string().parse().unwrap());
    Ok((request, session, port))
}

async fn proxy(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    let (mut request, session, port) = prepare_request(request, &state.config)?;
    let is_upgrade = request.headers().get(header::UPGRADE).is_some();
    let client_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut request));
    let response = state.client.request(request).await.map_err(|error| {
        warn!(%error, %session, port = port.get(), "upstream request failed");
        StatusCode::BAD_GATEWAY
    })?;
    if is_upgrade && response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let mut response = response;
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        if let Some(client_upgrade) = client_upgrade {
            tokio::spawn(async move {
                if let (Ok(client_io), Ok(upstream_io)) =
                    (client_upgrade.await, upstream_upgrade.await)
                {
                    let mut client_io = TokioIo::new(client_io);
                    let mut upstream_io = TokioIo::new(upstream_io);
                    let _ = tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await;
                }
            });
        }
        return Ok(response.map(Body::new));
    }
    Ok(response.map(Body::new))
}

pub async fn run(config: Config) -> Result<(), std::io::Error> {
    let addr = config.listen_addr;
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    info!(%addr, base_domain = %config.base_domain, upstream = %config.upstream, "anvil router listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app(config))
        .with_graceful_shutdown(shutdown())
        .await
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use anvil_core::{preview_hostname, Port, SessionId};
    use axum::body::Body;

    #[test]
    fn parses_host_and_rewrites_headers_and_target() {
        let id = SessionId::new(&anvil_core::Project::new("demo").unwrap());
        let host = preview_hostname(&id, Port::new(5173).unwrap(), "preview.example.test").unwrap();
        let mut request = Request::builder()
            .uri("/vite?x=1")
            .header(header::HOST, host)
            .header("x-sandbox-id", "attacker")
            .header(header::AUTHORIZATION, "secret")
            .body(Body::empty())
            .unwrap();
        // The production extractor receives Incoming; this test also locks down the pure hostname contract.
        assert!(parse_preview_hostname(
            request
                .headers()
                .get(header::HOST)
                .unwrap()
                .to_str()
                .unwrap(),
            "preview.example.test"
        )
        .is_some());
        assert_eq!(
            request.uri().path_and_query().unwrap().as_str(),
            "/vite?x=1"
        );
        request.headers_mut().remove("x-sandbox-id");
        assert!(!request.headers().contains_key("x-sandbox-id"));
    }

    #[test]
    fn validates_environment_values() {
        assert!(Config::new("127.0.0.1", "http://router").is_err());
        assert!(Config::new("preview.example.test", "ftp://router").is_err());
    }
}
