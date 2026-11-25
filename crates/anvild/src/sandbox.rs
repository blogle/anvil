use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

mod kubernetes;
pub use kubernetes::AgentSandboxProvider;

const SERVE_PORT: u16 = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct SandboxSpec {
    pub name: String,
    pub image: String,
    pub workspace: PathBuf,
    pub files: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SandboxHandle {
    pub name: String,
    pub serve_url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("sandbox names are [a-z0-9-], got: {name}")]
    InvalidName { name: String },
    #[error("podman failed: {stderr}")]
    Podman { stderr: String },
    #[error("Agent Sandbox: {0}")]
    Kubernetes(String),
    #[error("Kubernetes API: {0}")]
    KubernetesApi(#[from] kube::Error),
    #[error("sandbox {name} never became reachable: {cause}")]
    Unreachable { name: String, cause: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("transport: {0}")]
    Transport(#[from] reqwest::Error),
}

pub type SandboxOperation<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, SandboxError>> + Send + 'a>>;

pub trait SandboxProvider: Send + Sync {
    fn start<'a>(&'a self, spec: &'a SandboxSpec) -> SandboxOperation<'a, SandboxHandle>;
    fn handle<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, Option<SandboxHandle>>;
    fn destroy<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, ()>;
}

pub fn validate_name(name: &str) -> Result<(), SandboxError> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(SandboxError::InvalidName {
            name: name.to_owned(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct PodmanProvider {
    nix_store: PathBuf,
    nix_socket_dir: PathBuf,
}

impl Default for PodmanProvider {
    fn default() -> Self {
        Self {
            nix_store: PathBuf::from("/nix/store"),
            nix_socket_dir: PathBuf::from("/nix/var/nix/daemon-socket"),
        }
    }
}

impl PodmanProvider {
    pub async fn start(&self, spec: &SandboxSpec) -> Result<SandboxHandle, SandboxError> {
        validate_name(&spec.name)?;
        for (path, content) in &spec.files {
            let target = spec.workspace.join(path);
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(target, content).await?;
        }
        tokio::fs::create_dir_all(&spec.workspace).await?;

        let output = podman(&run_args(spec, &self.nix_store, &self.nix_socket_dir))
            .await?
            .map_err(|stderr| SandboxError::Podman { stderr })?;
        let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();

        let port = self.published_port(&name).await?;
        let serve_url = format!("http://127.0.0.1:{port}");
        self.await_ready(&serve_url)
            .await
            .map_err(|cause| SandboxError::Unreachable {
                name: name.clone(),
                cause,
            })?;
        Ok(SandboxHandle { name, serve_url })
    }

    pub async fn handle(&self, name: &str) -> Result<Option<SandboxHandle>, SandboxError> {
        if !self.is_running(name).await? {
            return Ok(None);
        }
        let port = self.published_port(name).await?;
        Ok(Some(SandboxHandle {
            name: name.to_owned(),
            serve_url: format!("http://127.0.0.1:{port}"),
        }))
    }

    pub async fn destroy(&self, name: &str) -> Result<(), SandboxError> {
        validate_name(name)?;
        let args = ["rm", "-f", name].map(str::to_owned);
        let result = podman(&args).await?;
        match result {
            Ok(_) => Ok(()),
            Err(stderr) if is_missing_container(&stderr) => Ok(()),
            Err(stderr) => Err(SandboxError::Podman { stderr }),
        }
    }

    pub async fn is_running(&self, name: &str) -> Result<bool, SandboxError> {
        validate_name(name)?;
        let args = ["inspect", "-f", "{{.State.Running}}", name].map(str::to_owned);
        match podman(&args).await? {
            Ok(output) => Ok(String::from_utf8_lossy(&output.stdout).trim() == "true"),
            Err(stderr) if is_missing_container(&stderr) => Ok(false),
            Err(stderr) => Err(SandboxError::Podman { stderr }),
        }
    }

    async fn published_port(&self, name: &str) -> Result<u16, SandboxError> {
        let args = ["port", name, &SERVE_PORT.to_string()].map(str::to_owned);
        let output = podman(&args)
            .await?
            .map_err(|stderr| SandboxError::Podman { stderr })?;
        let text = String::from_utf8_lossy(&output.stdout);
        text.trim()
            .rsplit(':')
            .next()
            .and_then(|port| port.parse().ok())
            .ok_or_else(|| SandboxError::Podman {
                stderr: format!("no published port in `podman port` output: {text}"),
            })
    }

    async fn await_ready(&self, serve_url: &str) -> Result<(), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("static reqwest client options are valid");
        loop {
            if let Ok(response) = client.get(format!("{serve_url}/api/info")).send().await {
                let status = response.status().as_u16();
                if status == 200 || status == 401 {
                    return Ok(());
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!("timeout probing {serve_url}/api/info"));
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }
}

fn is_missing_container(stderr: &str) -> bool {
    stderr.contains("no such container")
        || stderr.contains("no such object")
        || stderr.contains("no container with name or ID")
}

pub fn run_args(spec: &SandboxSpec, nix_store: &Path, nix_socket_dir: &Path) -> Vec<String> {
    let mut args = vec![
        "run".to_owned(),
        "-d".to_owned(),
        "--name".to_owned(),
        spec.name.clone(),
        "--network=pasta:--map-host-loopback=10.0.2.2".to_owned(),
        "-v".to_owned(),
        format!("{}:/nix/store:ro", nix_store.display()),
        "-v".to_owned(),
        format!("{}:/nix/var/nix/daemon-socket", nix_socket_dir.display()),
        "-v".to_owned(),
        format!("{}:/workspace", spec.workspace.display()),
    ];
    for (key, value) in spec.env.iter().chain(std::iter::once((
        &"NIX_REMOTE".to_owned(),
        &"daemon".to_owned(),
    ))) {
        args.push("-e".to_owned());
        args.push(format!("{key}={value}"));
    }
    args.push("-p".to_owned());
    args.push(format!("127.0.0.1::{SERVE_PORT}"));
    args.push(spec.image.clone());
    args
}

async fn podman(args: &[String]) -> Result<Result<std::process::Output, String>, SandboxError> {
    let output = tokio::process::Command::new("podman")
        .args(args)
        .output()
        .await?;
    if output.status.success() {
        Ok(Ok(output))
    } else {
        Ok(Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_owned()))
    }
}

impl SandboxProvider for PodmanProvider {
    fn start<'a>(&'a self, spec: &'a SandboxSpec) -> SandboxOperation<'a, SandboxHandle> {
        Box::pin(self.start(spec))
    }

    fn handle<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, Option<SandboxHandle>> {
        Box::pin(self.handle(name))
    }

    fn destroy<'a>(&'a self, name: &'a str) -> SandboxOperation<'a, ()> {
        Box::pin(self.destroy(name))
    }
}
