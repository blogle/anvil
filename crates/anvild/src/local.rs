use super::{
    BindingStateRecord, Config, CreateRequest, SandboxApi, SandboxRecord, ServiceError,
    WorkStateRecord,
};
use anvil_core::{branch_name, Run, Session, SessionId, WorkState};
use async_trait::async_trait;
use std::{
    collections::HashMap, net::TcpListener, path::PathBuf, process::Stdio, sync::Arc,
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};

struct LocalState {
    record: SandboxRecord,
    directory: PathBuf,
    child: Option<Child>,
    record_environment: Vec<(String, String)>,
}

/// Process-backed development implementation. Each session owns its workspace,
/// OpenCode HOME/state and dynamically allocated loopback endpoint.
pub struct LocalSandboxApi {
    config: Config,
    root: PathBuf,
    sessions: Arc<Mutex<HashMap<String, LocalState>>>,
}

impl LocalSandboxApi {
    pub fn new(config: Config) -> Result<Self, ServiceError> {
        let root = std::env::var_os("ANVIL_LOCAL_RUNTIME_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".anvil/dev/sessions"));
        std::fs::create_dir_all(&root)
            .map_err(|error| ServiceError::Config(format!("local runtime root: {error}")))?;
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
            sessions.insert(
                record.session.id.clone(),
                LocalState {
                    record,
                    directory: path,
                    child: None,
                    record_environment: Vec::new(),
                },
            );
        }
        Ok(Self {
            config,
            root,
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
        let home = state.directory.join("home");
        let project = home.join("workspace").join(&state.record.session.project);
        let profile = std::env::var_os("ANVIL_LOCAL_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".anvil/dev/profile"));
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
        let mut command = Command::new(
            std::env::var_os("ANVIL_OPENCODE_BIN").unwrap_or_else(|| "opencode".into()),
        );
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
                tokio::fs::write(
                    state.directory.join("worker.pid"),
                    child.id().unwrap_or_default().to_string(),
                )
                .await
                .map_err(local_error)?;
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
                state: "running".into(),
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
            self.launch(id, &mut state).await?;
            Ok(state)
        }
        .await;
        match result {
            Ok(state) => {
                let session = state.record.session.clone();
                persist(&directory, &state.record).await?;
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
}

async fn persist(directory: &std::path::Path, record: &SandboxRecord) -> Result<(), ServiceError> {
    let bytes = serde_json::to_vec_pretty(record).map_err(local_error)?;
    tokio::fs::write(directory.join("session.json"), bytes)
        .await
        .map_err(local_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_distinct_loopback_ports_for_concurrent_workers() {
        let ports: Vec<_> = (0..8).map(|_| allocate_loopback_port().unwrap()).collect();
        let unique: std::collections::HashSet<_> = ports.iter().collect();
        assert_eq!(unique.len(), ports.len());
    }
}
