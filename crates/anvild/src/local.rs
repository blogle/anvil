use super::{
    BindingStateRecord, Config, CreateRequest, SandboxApi, SandboxRecord, ServiceError,
    WorkStateRecord,
};
use anvil_core::{branch_name, Run, Session, SessionId, WorkState};
use async_trait::async_trait;
use std::{
    collections::HashMap, net::TcpListener, os::unix::fs::PermissionsExt, path::PathBuf,
    process::Stdio, sync::Arc, time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
    sync::Mutex,
};

struct LocalState {
    record: SandboxRecord,
    directory: PathBuf,
    child: Option<Child>,
    record_environment: Vec<(String, String)>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct WorkerProcessIdentity {
    pid: u32,
    port: u16,
    start_ticks: u64,
    executable: PathBuf,
    working_directory: PathBuf,
    argv: Vec<String>,
}

/// Process-backed development implementation. Each session owns its workspace,
/// OpenCode HOME/state and dynamically allocated loopback endpoint.
pub struct LocalSandboxApi {
    config: Config,
    root: PathBuf,
    opencode_bin: PathBuf,
    profile_dir: PathBuf,
    sessions: Arc<Mutex<HashMap<String, LocalState>>>,
}

impl LocalSandboxApi {
    pub fn new(config: Config) -> Result<Self, ServiceError> {
        let root = std::env::var_os("ANVIL_LOCAL_RUNTIME_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".anvil/dev/sessions"));
        let opencode_bin = std::env::var_os("ANVIL_OPENCODE_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("opencode"));
        let profile_dir = std::env::var_os("ANVIL_LOCAL_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".anvil/dev/profile"));
        Self::with_paths(config, root, opencode_bin, profile_dir)
    }

    fn with_paths(
        config: Config,
        root: PathBuf,
        opencode_bin: PathBuf,
        profile_dir: PathBuf,
    ) -> Result<Self, ServiceError> {
        std::fs::create_dir_all(&root)
            .map_err(|error| ServiceError::Config(format!("local runtime root: {error}")))?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| ServiceError::Config(format!("local runtime permissions: {error}")))?;
        let mut sessions = HashMap::new();
        for entry in std::fs::read_dir(&root).map_err(local_error)? {
            let entry = entry.map_err(local_error)?;
            let path = entry.path();
            let Ok(bytes) = std::fs::read(path.join("session.json")) else {
                continue;
            };
            let Ok(record) = serde_json::from_slice::<SandboxRecord>(&bytes) else {
                continue;
            };
            let record_environment = std::fs::read(path.join("sandbox-env.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            sessions.insert(
                record.session.id.clone(),
                LocalState {
                    record,
                    directory: path,
                    child: None,
                    record_environment,
                },
            );
        }
        Ok(Self {
            config,
            root,
            opencode_bin,
            profile_dir,
            sessions: Arc::new(Mutex::new(sessions)),
        })
    }

    async fn launch(&self, id: &str, state: &mut LocalState) -> Result<(), ServiceError> {
        if state
            .child
            .as_ref()
            .is_some_and(|child| child.id().is_some())
            && health(
                state.record.session.service.as_str(),
                state.record.session.opencode_port,
            )
            .await
            .is_ok()
        {
            state.record.session.environment_state = "ready".into();
            return Ok(());
        }
        if let Some(mut child) = state.child.take() {
            if child.try_wait().map_err(local_error)?.is_none() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        if state.child.is_none() {
            stop_recorded_worker(&state.directory).await?;
        }
        let home = state.directory.join("home");
        let project = home.join("workspace").join(&state.record.session.project);
        let profile = &self.profile_dir;
        for path in [
            &home,
            &project,
            &home.join(".config"),
            &home.join(".cache"),
            &home.join(".local/share/opencode"),
            &home.join(".local/state/runtime"),
        ] {
            tokio::fs::create_dir_all(path).await.map_err(local_error)?;
        }
        let port = state.record.session.opencode_port;
        let port_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => {
                    drop(listener);
                    break;
                }
                Err(error) if tokio::time::Instant::now() < port_deadline => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    if tokio::time::Instant::now() >= port_deadline {
                        return Err(ServiceError::OpenCode(format!(
                            "local OpenCode port {port} is still occupied after safe stale-worker cleanup: {error}"
                        )));
                    }
                }
                Err(error) => {
                    return Err(ServiceError::OpenCode(format!(
                        "local OpenCode port {port} is still occupied after safe stale-worker cleanup: {error}"
                    )))
                }
            }
        }
        let mut command = Command::new(&self.opencode_bin);
        command
            .args([
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
            .current_dir(&project)
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_STATE_HOME", home.join(".local/state"))
            .env("XDG_RUNTIME_DIR", home.join(".local/state/runtime"))
            .env("ANVIL_PROJECT", &state.record.session.project)
            .env("ANVIL_REPOSITORY", &state.record.session.repository)
            .env("ANVIL_REF", &state.record.session.base_ref)
            .env("ANVIL_WORK_BRANCH", &state.record.session.work_branch)
            .env(
                "ANVIL_RUN_ID",
                state
                    .record
                    .work_state
                    .run_id
                    .as_deref()
                    .unwrap_or_default(),
            )
            .env("ANVIL_SESSION_ID", id)
            .env("OPENCODE_CONFIG", profile.join("config/opencode.jsonc"))
            .env("OPENCODE_CONFIG_DIR", profile.join("config"))
            .env("OPENCODE_DISABLE_CHANNEL_DB", "1")
            .env("DISPLAY", ":99")
            .stdin(Stdio::null());
        let worker_log =
            std::fs::File::create(state.directory.join("worker.log")).map_err(local_error)?;
        command
            .stdout(Stdio::from(worker_log.try_clone().map_err(local_error)?))
            .stderr(Stdio::from(worker_log));
        for (key, value) in &state.record_environment {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| ServiceError::OpenCode(format!("start local opencode: {error}")))?;
        let deadline = tokio::time::Instant::now() + self.config.request_timeout;
        loop {
            if health("127.0.0.1", port).await.is_ok() {
                let Some(pid) = child.id() else {
                    terminate_child(&mut child).await;
                    return Err(ServiceError::OpenCode(
                        "local opencode process has no PID".into(),
                    ));
                };
                if let Err(error) =
                    tokio::fs::write(state.directory.join("worker.pid"), pid.to_string()).await
                {
                    terminate_child(&mut child).await;
                    return Err(local_error(error));
                }
                let Some(identity) = process_identity(pid, port) else {
                    terminate_child(&mut child).await;
                    return Err(ServiceError::OpenCode(
                        "unable to inspect local opencode process".into(),
                    ));
                };
                let serialized = match serde_json::to_vec_pretty(&identity) {
                    Ok(serialized) => serialized,
                    Err(error) => {
                        terminate_child(&mut child).await;
                        return Err(local_error(error));
                    }
                };
                if let Err(error) =
                    tokio::fs::write(state.directory.join("worker.process.json"), serialized).await
                {
                    terminate_child(&mut child).await;
                    return Err(local_error(error));
                }
                state.child = Some(child);
                state.record.session.environment_state = "ready".into();
                state.record.session.service = "127.0.0.1".into();
                state.record.session.opencode_port = port;
                state.record.session.ready_at = Some(chrono::Utc::now().to_rfc3339());
                return Ok(());
            }
            if let Some(status) = child.try_wait().map_err(local_error)? {
                return Err(ServiceError::OpenCode(format!(
                    "local opencode exited during startup: {status}"
                )));
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(ServiceError::OpenCode(
                    "local opencode health timed out".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

impl Drop for LocalSandboxApi {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.try_lock() {
            for state in sessions.values_mut() {
                if let Some(child) = state.child.as_mut() {
                    let _ = child.start_kill();
                }
            }
        }
    }
}

async fn health(host: &str, port: u16) -> Result<(), ()> {
    reqwest::Client::new()
        .get(format!("http://{host}:{port}/global/health"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    Ok(())
}

async fn terminate_child(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn local_error(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::Kubernetes(error.to_string())
}

fn allocate_loopback_port() -> Result<u16, ServiceError> {
    TcpListener::bind(("127.0.0.1", 0))
        .map_err(local_error)?
        .local_addr()
        .map(|address| address.port())
        .map_err(local_error)
}

fn process_identity(pid: u32, port: u16) -> Option<WorkerProcessIdentity> {
    let proc = PathBuf::from(format!("/proc/{pid}"));
    let stat = std::fs::read_to_string(proc.join("stat")).ok()?;
    let rest = stat.rsplit_once(')')?.1.trim_start();
    let start_ticks = rest.split_whitespace().nth(19)?.parse().ok()?;
    let executable = std::fs::read_link(proc.join("exe")).ok()?;
    let working_directory = std::fs::read_link(proc.join("cwd")).ok()?;
    let argv = std::fs::read(proc.join("cmdline"))
        .ok()?
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    Some(WorkerProcessIdentity {
        pid,
        port,
        start_ticks,
        executable,
        working_directory,
        argv,
    })
}

fn same_worker_process(expected: &WorkerProcessIdentity, current: &WorkerProcessIdentity) -> bool {
    expected.pid == current.pid
        && expected.port == current.port
        && expected.start_ticks == current.start_ticks
        && expected.executable == current.executable
        && expected.working_directory == current.working_directory
        && expected.argv == current.argv
}

async fn stop_recorded_worker(directory: &std::path::Path) -> Result<(), ServiceError> {
    let metadata = directory.join("worker.process.json");
    if let Ok(bytes) = tokio::fs::read(&metadata).await {
        if let Ok(expected) = serde_json::from_slice::<WorkerProcessIdentity>(&bytes) {
            if process_identity(expected.pid, expected.port)
                .as_ref()
                .is_some_and(|current| same_worker_process(&expected, current))
            {
                let status = tokio::process::Command::new("kill")
                    .args(["-TERM", &expected.pid.to_string()])
                    .status()
                    .await
                    .map_err(local_error)?;
                if !status.success() {
                    return Err(ServiceError::OpenCode(format!(
                        "unable to stop recorded worker process {}",
                        expected.pid
                    )));
                }
                let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                while process_identity(expected.pid, expected.port)
                    .as_ref()
                    .is_some_and(|current| same_worker_process(&expected, current))
                    && tokio::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                if process_identity(expected.pid, expected.port)
                    .as_ref()
                    .is_some_and(|current| same_worker_process(&expected, current))
                {
                    let _ = tokio::process::Command::new("kill")
                        .args(["-KILL", &expected.pid.to_string()])
                        .status()
                        .await;
                }
            }
        }
    }
    let _ = tokio::fs::remove_file(metadata).await;
    let _ = tokio::fs::remove_file(directory.join("worker.pid")).await;
    // A legacy PID-only marker is deliberately not trusted. PID reuse makes it
    // unsafe to signal without the executable, cwd, argv and start-time tuple.
    Ok(())
}

#[async_trait]
impl SandboxApi for LocalSandboxApi {
    async fn list(&self) -> Result<Vec<SandboxRecord>, ServiceError> {
        Ok(self
            .sessions
            .lock()
            .await
            .values()
            .map(|state| state.record.clone())
            .collect())
    }

    async fn get(&self, id: &str) -> Result<SandboxRecord, ServiceError> {
        self.sessions
            .lock()
            .await
            .get(id)
            .map(|state| state.record.clone())
            .ok_or(ServiceError::NotFound)
    }

    async fn create(
        &self,
        id: &str,
        request: &CreateRequest,
        sandbox_env: &[(String, String)],
    ) -> Result<Session, ServiceError> {
        let directory = self.root.join(id);
        if directory.exists() {
            return Err(ServiceError::Conflict(format!(
                "local session {id} already exists"
            )));
        }
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(local_error)?;
        if let Err(error) =
            tokio::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).await
        {
            let _ = tokio::fs::remove_dir_all(&directory).await;
            return Err(local_error(error));
        }
        let result = async {
            let home = directory.join("home");
            let project = home.join("workspace").join(&request.project);
            tokio::fs::create_dir_all(project.parent().unwrap())
                .await
                .map_err(local_error)?;
            let output = Command::new("git")
                .args([
                    "clone",
                    "--branch",
                    &request.base_ref,
                    "--single-branch",
                    &request.repository,
                    project.to_str().ok_or_else(|| {
                        ServiceError::Invalid("repository path is not valid Unicode".into())
                    })?,
                ])
                .output()
                .await
                .map_err(local_error)?;
            if !output.status.success() {
                return Err(ServiceError::Kubernetes(format!(
                    "git clone failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
            let session_id = SessionId::parse(id)
                .ok_or_else(|| ServiceError::Invalid("invalid session ID".into()))?;
            let work_branch = branch_name(&session_id);
            let output = Command::new("git")
                .args([
                    "-C",
                    project.to_str().unwrap(),
                    "switch",
                    "-c",
                    &work_branch,
                ])
                .output()
                .await
                .map_err(local_error)?;
            if !output.status.success() {
                return Err(ServiceError::Kubernetes(format!(
                    "git work branch failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
            let port = allocate_loopback_port()?;
            let now = chrono::Utc::now().to_rfc3339();
            let run = Run {
                id: format!("run_{}", uuid::Uuid::new_v4().simple()),
                state: "submitted".into(),
                started_at: now.clone(),
                finished_at: None,
            };
            let session = Session {
                id: id.into(),
                sandbox: format!("anvil-{id}"),
                service: "127.0.0.1".into(),
                namespace: "local".into(),
                opencode_port: port,
                phase: Some("Ready".into()),
                project: request.project.clone(),
                repository: request.repository.clone(),
                base_ref: request.base_ref.clone(),
                work_branch,
                model: request.model.clone(),
                opencode_session_id: None,
                created_at: Some(now.clone()),
                ready_at: None,
                environment_state: "provisioning".into(),
                environment_error: None,
                work_state: WorkState::InProgress.as_str().into(),
                work_state_changed_at: Some(now.clone()),
                work_state_summary: None,
                work_state_run_id: Some(run.id.clone()),
                current_run: Some(run.clone()),
                last_run: None,
                session_binding_state: "pending".into(),
                session_binding_continuity: "exact".into(),
                session_binding_error: None,
                session_binding_checked_at: Some(now.clone()),
                previous_opencode_session_id: None,
                session_binding_recovery_event: None,
            };
            let state = SandboxRecord {
                session: session.clone(),
                work_state: WorkStateRecord {
                    state: WorkState::InProgress,
                    changed_at: now.clone(),
                    summary: None,
                    run_id: Some(run.id.clone()),
                    current_run: Some(run),
                    last_run: None,
                },
                binding_state: BindingStateRecord {
                    state: "pending".into(),
                    continuity: "exact".into(),
                    checked_at: now,
                    error: None,
                    previous_session_id: None,
                    recovery_event: None,
                },
                operating_mode: "Running".into(),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            let mut state = LocalState {
                record: state,
                directory: directory.clone(),
                child: None,
                record_environment: sandbox_env.to_vec(),
            };
            let environment_path = directory.join("sandbox-env.json");
            tokio::fs::write(
                &environment_path,
                serde_json::to_vec(&state.record_environment).map_err(local_error)?,
            )
            .await
            .map_err(local_error)?;
            tokio::fs::set_permissions(environment_path, std::fs::Permissions::from_mode(0o600))
                .await
                .map_err(local_error)?;
            self.launch(id, &mut state).await?;
            Ok(state)
        }
        .await;
        match result {
            Ok(mut state) => {
                let session = state.record.session.clone();
                if let Err(error) = persist(&directory, &state.record).await {
                    if let Some(mut child) = state.child.take() {
                        terminate_child(&mut child).await;
                    }
                    let _ = tokio::fs::remove_dir_all(&directory).await;
                    return Err(error);
                }
                self.sessions.lock().await.insert(id.into(), state);
                Ok(session)
            }
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&directory).await;
                Err(error)
            }
        }
    }

    async fn suspend(&self, id: &str) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        if let Some(mut child) = state.child.take() {
            child.kill().await.map_err(local_error)?;
            let _ = child.wait().await;
        }
        let _ = tokio::fs::remove_file(state.directory.join("worker.process.json")).await;
        let _ = tokio::fs::remove_file(state.directory.join("worker.pid")).await;
        state.record.session.environment_state = "suspended".into();
        state.record.operating_mode = "Suspended".into();
        persist(&state.directory, &state.record).await
    }

    async fn resume(&self, id: &str) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        self.launch(id, state).await?;
        state.record.session.environment_state = "ready".into();
        state.record.operating_mode = "Running".into();
        persist(&state.directory, &state.record).await
    }

    async fn delete(&self, id: &str) -> Result<(), ServiceError> {
        let mut state = self
            .sessions
            .lock()
            .await
            .remove(id)
            .ok_or(ServiceError::NotFound)?;
        if let Some(mut child) = state.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        tokio::fs::remove_dir_all(state.directory)
            .await
            .map_err(local_error)
    }

    async fn set_opencode_session(&self, id: &str, value: &str) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        state.record.session.opencode_session_id = Some(value.into());
        state.record.binding_state.state = "available".into();
        state.record.session.session_binding_state = "available".into();
        persist(&state.directory, &state.record).await
    }
    async fn set_model(&self, id: &str, value: &str) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        state.record.session.model = Some(value.into());
        persist(&state.directory, &state.record).await
    }
    async fn set_ready_at(&self, id: &str, value: &str) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        state.record.session.ready_at = Some(value.into());
        persist(&state.directory, &state.record).await
    }
    async fn set_work_state(&self, id: &str, value: &WorkStateRecord) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        state.record.work_state = value.clone();
        state.record.session.work_state = value.state.as_str().into();
        state.record.session.work_state_changed_at = Some(value.changed_at.clone());
        state.record.session.work_state_summary = value.summary.clone();
        state.record.session.work_state_run_id = value.run_id.clone();
        state.record.session.current_run = value.current_run.clone();
        state.record.session.last_run = value.last_run.clone();
        persist(&state.directory, &state.record).await
    }
    async fn set_binding_state(
        &self,
        id: &str,
        value: &BindingStateRecord,
    ) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        let state = sessions.get_mut(id).ok_or(ServiceError::NotFound)?;
        state.record.binding_state = value.clone();
        state.record.session.session_binding_state = value.state.clone();
        state.record.session.session_binding_continuity = value.continuity.clone();
        state.record.session.session_binding_error = value.error.clone();
        state.record.session.previous_opencode_session_id = value.previous_session_id.clone();
        state.record.session.session_binding_recovery_event = value.recovery_event.clone();
        persist(&state.directory, &state.record).await
    }

    async fn recover_startup(&self) -> Result<(), ServiceError> {
        let mut sessions = self.sessions.lock().await;
        for (id, state) in sessions.iter_mut() {
            if state.record.session.environment_state == "suspended" {
                stop_recorded_worker(&state.directory).await?;
                continue;
            }
            self.launch(id, state).await?;
            persist(&state.directory, &state.record).await?;
        }
        Ok(())
    }
}

async fn persist(directory: &std::path::Path, record: &SandboxRecord) -> Result<(), ServiceError> {
    let bytes = serde_json::to_vec_pretty(record).map_err(local_error)?;
    let temporary = directory.join("session.json.tmp");
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .await
        .map_err(local_error)?;
    file.write_all(&bytes).await.map_err(local_error)?;
    file.sync_all().await.map_err(local_error)?;
    drop(file);
    tokio::fs::rename(temporary, directory.join("session.json"))
        .await
        .map_err(local_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SandboxBackend;

    #[tokio::test]
    async fn fake_opencode_worker_process() {
        let Ok(port) = std::env::var("ANVIL_TEST_FAKE_OPENCODE_PORT") else {
            return;
        };
        let port: u16 = port.parse().unwrap();
        let app = axum::Router::new()
            .route(
                "/global/health",
                axum::routing::get(|| async { axum::http::StatusCode::OK }),
            )
            .route(
                "/session/:id",
                axum::routing::get(
                    |axum::extract::Path(id): axum::extract::Path<String>| async move {
                        axum::Json(serde_json::json!({"id":id}))
                    },
                ),
            )
            .route(
                "/session/status",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"persistent-conversation":{"type":"idle"}}))
                }),
            );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        axum::serve(listener, app).await.unwrap();
    }

    fn test_config() -> Config {
        Config {
            sandbox_backend: SandboxBackend::Local,
            bind_port: 0,
            namespace: "local".into(),
            image: "unused".into(),
            workspace_size: "1Gi".into(),
            opencode_port: 4096,
            request_timeout: Duration::from_secs(10),
            preview_domain: "localhost".into(),
            annotation_prefix: "anvil.local".into(),
            profile_opencode_url: "http://127.0.0.1:4097".into(),
            profile_pvc: "unused".into(),
            credential_url: "http://127.0.0.1:8080".into(),
            github_app_id: None,
            github_installation_id: None,
            github_private_key: None,
            session_signing_secret: None,
            session_capability_ttl: Duration::from_secs(60),
            github_api_url: "https://api.github.com".into(),
            history_path: std::env::temp_dir().join("anvil-local-test-history.jsonl"),
        }
    }

    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
        runtime: PathBuf,
        profile: PathBuf,
        fake_opencode: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("anvil-local-{}", uuid::Uuid::new_v4()));
            let repo = root.join("fixture-repo");
            let runtime = root.join("runtime");
            let profile = root.join("profile");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::create_dir_all(profile.join("config")).unwrap();
            std::fs::write(profile.join("config/opencode.jsonc"), "{}\n").unwrap();
            let output = std::process::Command::new("git")
                .args(["init", "-b", "main"])
                .arg(&repo)
                .output()
                .unwrap();
            assert!(output.status.success());
            for (key, value) in [
                ("user.name", "Fixture"),
                ("user.email", "fixture@example.invalid"),
            ] {
                let output = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(["config", key, value])
                    .output()
                    .unwrap();
                assert!(output.status.success());
            }
            std::fs::write(repo.join("target.txt"), "before\n").unwrap();
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["add", "target.txt"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["commit", "-m", "fixture"])
                .output()
                .unwrap();
            assert!(output.status.success());

            let fake_opencode = root.join("opencode-test-worker");
            let test_binary = std::env::current_exe().unwrap();
            let test_binary = test_binary.to_string_lossy().replace('\'', "'\\''");
            std::fs::write(
                &fake_opencode,
                format!(
                    "#!/bin/sh\nexport ANVIL_TEST_FAKE_OPENCODE_PORT=\"$5\"\nexec '{test_binary}' --exact local::tests::fake_opencode_worker_process --nocapture\n"
                ),
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&fake_opencode).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&fake_opencode, permissions).unwrap();

            Self {
                root,
                repo,
                runtime,
                profile,
                fake_opencode,
            }
        }

        fn api(&self) -> LocalSandboxApi {
            LocalSandboxApi::with_paths(
                test_config(),
                self.runtime.clone(),
                self.fake_opencode.clone(),
                self.profile.clone(),
            )
            .unwrap()
        }

        fn request(&self, project: &str) -> CreateRequest {
            CreateRequest {
                project: project.into(),
                repository: url::Url::from_file_path(&self.repo).unwrap().to_string(),
                base_ref: "main".into(),
                prompt: "test".into(),
                model: None,
                author_name: None,
                author_email: None,
            }
        }

        fn cleanup(&self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn pid_is_alive(pid: u32) -> bool {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }

    #[test]
    fn allocates_distinct_loopback_ports_for_concurrent_workers() {
        let ports: Vec<_> = (0..8).map(|_| allocate_loopback_port().unwrap()).collect();
        let unique: std::collections::HashSet<_> = ports.iter().collect();
        assert_eq!(unique.len(), ports.len());
    }

    #[tokio::test]
    async fn local_backend_preserves_workspace_and_conversation_across_suspend_resume_and_restart()
    {
        let fixture = Fixture::new();
        let api = fixture.api();
        let session = api
            .create(
                "demo-12345678",
                &fixture.request("demo"),
                &[("ANVIL_TEST_ENV".into(), "retained".into())],
            )
            .await
            .unwrap();
        api.set_opencode_session(&session.id, "persistent-conversation")
            .await
            .unwrap();
        let directory = fixture.runtime.join(&session.id);
        let workspace = directory.join("home/workspace/demo/target.txt");
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(directory.join("session.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(directory.join("sandbox-env.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(std::fs::read_to_string(&workspace).unwrap(), "before\n");
        let first_pid: u32 = std::fs::read_to_string(directory.join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        api.suspend(&session.id).await.unwrap();
        assert!(!pid_is_alive(first_pid));
        assert!(directory.join("home/.local/share/opencode").exists());
        api.resume(&session.id).await.unwrap();
        let second_pid: u32 = std::fs::read_to_string(directory.join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_ne!(first_pid, second_pid);
        assert_eq!(std::fs::read_to_string(&workspace).unwrap(), "before\n");
        assert_eq!(
            api.get(&session.id)
                .await
                .unwrap()
                .session
                .opencode_session_id
                .as_deref(),
            Some("persistent-conversation")
        );
        let saved_identity: WorkerProcessIdentity =
            serde_json::from_slice(&std::fs::read(directory.join("worker.process.json")).unwrap())
                .unwrap();
        let current_identity = process_identity(second_pid, session.opencode_port).unwrap();
        assert!(
            same_worker_process(&saved_identity, &current_identity),
            "saved worker identity did not match current process: saved={saved_identity:?} current={current_identity:?}"
        );

        {
            let mut sessions = api.sessions.lock().await;
            let state = sessions.get_mut(&session.id).unwrap();
            // Simulate daemon loss: leave the worker running and relinquish the
            // Tokio Child handle without invoking LocalSandboxApi::drop cleanup.
            state.child.take();
        }
        drop(api);
        let restarted = fixture.api();
        restarted.recover_startup().await.unwrap();
        let third_pid: u32 = std::fs::read_to_string(directory.join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_ne!(third_pid, second_pid);
        assert!(!pid_is_alive(second_pid));
        let recovered = restarted.get(&session.id).await.unwrap();
        assert_eq!(
            recovered.session.opencode_session_id.as_deref(),
            Some("persistent-conversation")
        );
        assert_eq!(recovered.session.environment_state, "ready");
        assert_eq!(
            std::fs::read_to_string(directory.join("sandbox-env.json")).unwrap(),
            r#"[["ANVIL_TEST_ENV","retained"]]"#
        );
        restarted.delete(&session.id).await.unwrap();
        assert!(!directory.exists());
        assert!(!pid_is_alive(third_pid));
        fixture.cleanup();
    }

    #[tokio::test]
    async fn local_backend_cleans_failed_creates_and_isolates_concurrent_workers() {
        let fixture = Fixture::new();
        let api = fixture.api();
        let mut invalid = fixture.request("failed");
        invalid.base_ref = "missing-ref".into();
        assert!(api.create("failed-12345678", &invalid, &[]).await.is_err());
        assert!(!fixture.runtime.join("failed-12345678").exists());

        let first_request = fixture.request("demo");
        let second_request = fixture.request("other");
        let (first, second) = tokio::join!(
            api.create("demo-12345678", &first_request, &[]),
            api.create("other-12345679", &second_request, &[]),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first.opencode_port, second.opencode_port);
        let first_dir = fixture.runtime.join(&first.id);
        let second_dir = fixture.runtime.join(&second.id);
        assert_ne!(first_dir, second_dir);
        assert!(first_dir.join("home/workspace/demo/target.txt").exists());
        assert!(second_dir.join("home/workspace/other/target.txt").exists());
        let first_pid: u32 = std::fs::read_to_string(first_dir.join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        let second_pid: u32 = std::fs::read_to_string(second_dir.join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        api.delete(&first.id).await.unwrap();
        api.delete(&second.id).await.unwrap();
        assert!(!pid_is_alive(first_pid));
        assert!(!pid_is_alive(second_pid));
        assert!(TcpListener::bind(("127.0.0.1", first.opencode_port)).is_ok());
        assert!(TcpListener::bind(("127.0.0.1", second.opencode_port)).is_ok());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn stale_cleanup_refuses_pid_reuse_and_legacy_pid_only_markers() {
        let directory = std::env::temp_dir().join(format!("anvil-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = unrelated.id().unwrap();
        let identity = process_identity(pid, 4096).unwrap();
        let mut reused_pid = identity.clone();
        reused_pid.start_ticks = reused_pid.start_ticks.saturating_add(1);
        tokio::fs::write(
            directory.join("worker.process.json"),
            serde_json::to_vec(&reused_pid).unwrap(),
        )
        .await
        .unwrap();
        stop_recorded_worker(&directory).await.unwrap();
        assert!(unrelated.try_wait().unwrap().is_none());

        tokio::fs::write(directory.join("worker.pid"), pid.to_string())
            .await
            .unwrap();
        stop_recorded_worker(&directory).await.unwrap();
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().await.unwrap();
        let _ = unrelated.wait().await;
        std::fs::remove_dir_all(directory).unwrap();
    }
}
