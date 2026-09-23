//! HTTP control plane for Anvil Kubernetes sandboxes.

mod github;

use anvil_core::{
    branch_name, normalize_summary, preview_hostname, validate_worker_transition, GitRef,
    LifecycleEvent, LoginFlow, Port, Project, Prompt, ProviderAuthMethod, ProviderListResponse,
    ProviderStatus, ProviderSummary, Repository, Run, Session, SessionActivity, SessionId,
    SessionRequest, WorkState, WorkerDisposition,
};
use async_trait::async_trait;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use kube::{
    api::{
        Api, ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
    },
    Client, ResourceExt,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use thiserror::Error;
use tokio::{io::AsyncWriteExt, sync::Mutex as AsyncMutex};
use tracing::{info, warn};

const MANAGED: &str = "app.kubernetes.io/managed-by";
const APP: &str = "app.kubernetes.io/name";
const LOGIN_TTL: Duration = Duration::from_secs(10 * 60);
const RUNTIME_LAYOUT: &str = "v2";

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_port: u16,
    pub namespace: String,
    pub image: String,
    pub workspace_size: String,
    pub opencode_port: u16,
    pub request_timeout: Duration,
    pub preview_domain: String,
    pub annotation_prefix: String,
    pub profile_opencode_url: String,
    pub profile_pvc: String,
    pub credential_url: String,
    pub github_app_id: Option<String>,
    pub github_installation_id: Option<u64>,
    pub github_private_key: Option<String>,
    pub session_signing_secret: Option<String>,
    pub session_capability_ttl: Duration,
    pub github_api_url: String,
    pub history_path: PathBuf,
}
impl Config {
    pub fn from_env() -> Result<Self, ServiceError> {
        let get = |k: &str, d: &str| {
            env::var(k)
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| d.into())
        };
        let required = |key: &str| {
            env::var(key)
                .ok()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ServiceError::Config(format!("{key} is required")))
        };
        let session_signing_secret = required("ANVIL_SESSION_SIGNING_SECRET")?;
        if session_signing_secret.len() < 32 {
            return Err(ServiceError::Config(
                "ANVIL_SESSION_SIGNING_SECRET must be at least 32 bytes".into(),
            ));
        }
        let github_app_id = required("ANVIL_GITHUB_APP_ID")?;
        let github_private_key = required("ANVIL_GITHUB_PRIVATE_KEY")?;
        let github_installation_id = required("ANVIL_GITHUB_INSTALLATION_ID")?
            .parse()
            .map_err(|_| ServiceError::Config("ANVIL_GITHUB_INSTALLATION_ID".into()))?;
        Ok(Self {
            bind_port: get("ANVIL_BIND_PORT", "8080")
                .parse()
                .map_err(|_| ServiceError::Config("ANVILD_PORT".into()))?,
            namespace: get("ANVIL_NAMESPACE", "anvil"),
            image: get("ANVIL_SANDBOX_IMAGE", "anvil-sandbox:dev"),
            workspace_size: get("ANVIL_WORKSPACE_SIZE", "20Gi"),
            opencode_port: get("OPENCODE_PORT", "4096")
                .parse()
                .map_err(|_| ServiceError::Config("OPENCODE_PORT".into()))?,
            request_timeout: Duration::from_secs(
                get("ANVIL_PROVISION_TIMEOUT", "180")
                    .parse()
                    .map_err(|_| ServiceError::Config("ANVIL_PROVISION_TIMEOUT".into()))?,
            ),
            preview_domain: env::var("ANVIL_PREVIEW_DOMAIN")
                .map_err(|_| ServiceError::Config("ANVIL_PREVIEW_DOMAIN is required".into()))?,
            annotation_prefix: env::var("ANVIL_ANNOTATION_PREFIX")
                .map_err(|_| ServiceError::Config("ANVIL_ANNOTATION_PREFIX is required".into()))?
                .trim_end_matches('/')
                .to_owned(),
            profile_opencode_url: env::var("ANVIL_PROFILE_OPENCODE_URL").map_err(|_| {
                ServiceError::Config("ANVIL_PROFILE_OPENCODE_URL is required".into())
            })?,
            profile_pvc: get("ANVIL_PROFILE_PVC", "anvil-opencode-profile"),
            credential_url: get("ANVIL_CREDENTIAL_URL", "http://anvild:8080"),
            github_app_id: Some(github_app_id),
            github_installation_id: Some(github_installation_id),
            github_private_key: Some(github_private_key),
            session_signing_secret: Some(session_signing_secret),
            session_capability_ttl: Duration::from_secs(
                get("ANVIL_SESSION_CAPABILITY_TTL", "86400")
                    .parse()
                    .map_err(|_| ServiceError::Config("ANVIL_SESSION_CAPABILITY_TTL".into()))?,
            ),
            github_api_url: get("ANVIL_GITHUB_API_URL", "https://api.github.com"),
            history_path: PathBuf::from(get("ANVIL_HISTORY_PATH", "/var/lib/anvil/history.jsonl")),
        })
    }
}

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("kubernetes error: {0}")]
    Kubernetes(String),
    #[error("OpenCode error: {0}")]
    OpenCode(String),
    #[error("profile OpenCode error: {0}")]
    Profile(String),
    #[error("session not found")]
    NotFound,
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("session recovery required: {0}")]
    Recovery(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("GitHub credential broker error: {0}")]
    Github(#[from] github::GithubError),
}
impl IntoResponse for ServiceError {
    fn into_response(self) -> axum::response::Response {
        if let ServiceError::Github(error) = &self {
            let status = match error {
                github::GithubError::Transport(_) => StatusCode::SERVICE_UNAVAILABLE,
                github::GithubError::Configuration(_)
                | github::GithubError::Jwt(_)
                | github::GithubError::Cache => StatusCode::INTERNAL_SERVER_ERROR,
                github::GithubError::Repository(_)
                | github::GithubError::Upstream { .. }
                | github::GithubError::MalformedResponse { .. } => StatusCode::BAD_GATEWAY,
            };
            return (status, Json(json!({"error": error.diagnostic()}))).into_response();
        }
        let status = match &self {
            ServiceError::NotFound => StatusCode::NOT_FOUND,
            ServiceError::Unauthorized => StatusCode::UNAUTHORIZED,
            ServiceError::Forbidden(_) => StatusCode::FORBIDDEN,
            ServiceError::Conflict(_) => StatusCode::CONFLICT,
            ServiceError::Recovery(_) => StatusCode::CONFLICT,
            ServiceError::Invalid(_) => StatusCode::BAD_REQUEST,
            ServiceError::OpenCode(_) => StatusCode::BAD_GATEWAY,
            ServiceError::Profile(_) => StatusCode::BAD_GATEWAY,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            Json(json!({"error":{"code":status.as_u16(),"message":self.to_string()}})),
        )
            .into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub project: String,
    pub repository: String,
    #[serde(rename = "ref")]
    pub base_ref: String,
    pub prompt: String,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_email: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct PromptRequest {
    pub prompt: String,
}

#[derive(Debug, Deserialize)]
pub struct RecoveryRequest {
    pub prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReportRequest {
    pub run_id: String,
    pub disposition: String,
    pub summary: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReportResponse {
    pub accepted: bool,
    pub session_id: String,
    pub run_id: String,
    pub work_state: String,
    pub work_state_changed_at: String,
}
#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    #[serde(rename = "messageID")]
    pub message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderLoginRequest {
    pub method: Option<String>,
    #[serde(default)]
    pub inputs: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderCompleteRequest {
    pub code: Option<String>,
    pub key: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct GithubCredentialRequest {
    #[serde(default)]
    purpose: github::GithubCredentialPurpose,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryEvent {
    session_id: String,
    kind: String,
    at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Clone)]
struct HistoryStore {
    path: PathBuf,
    lock: Arc<AsyncMutex<()>>,
}

impl HistoryStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Arc::new(AsyncMutex::new(())),
        }
    }

    async fn append(&self, event: HistoryEvent) -> Result<(), ServiceError> {
        let _guard = self.lock.lock().await;
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| ServiceError::Kubernetes(format!("history directory: {error}")))?;
        }
        let mut line = serde_json::to_vec(&event)
            .map_err(|error| ServiceError::Config(format!("history serialization: {error}")))?;
        line.push(b'\n');
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(|error| ServiceError::Kubernetes(format!("history open: {error}")))?;
        file.write_all(&line)
            .await
            .map_err(|error| ServiceError::Kubernetes(format!("history append: {error}")))?;
        file.flush()
            .await
            .map_err(|error| ServiceError::Kubernetes(format!("history flush: {error}")))
    }

    async fn for_session(&self, session_id: &str) -> Vec<HistoryEvent> {
        let _guard = self.lock.lock().await;
        let Ok(bytes) = tokio::fs::read(&self.path).await else {
            return Vec::new();
        };
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(|line| serde_json::from_str::<HistoryEvent>(line).ok())
            .filter(|event| event.session_id == session_id)
            .collect()
    }
}

#[derive(Debug, Clone)]
struct PendingLogin {
    provider: String,
    method: PendingLoginMethod,
    created_at: std::time::Instant,
}

#[derive(Debug, Clone, Copy)]
enum PendingLoginMethod {
    OAuth(usize),
    ApiKey,
}

#[derive(Debug, Deserialize)]
struct OpenCodeProvider {
    id: String,
    name: String,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    models: HashMap<String, OpenCodeModel>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeProviderList {
    #[serde(default)]
    all: Vec<OpenCodeProvider>,
    #[serde(default)]
    connected: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct OpenCodeModel {
    id: String,
    #[serde(rename = "providerID")]
    provider_id: String,
}
impl OpenCodeModel {
    fn qualified_id(&self) -> String {
        format!("{}/{}", self.provider_id, self.id)
    }
}

#[derive(Debug, Deserialize)]
struct OpenCodeConfiguredProviders {
    #[serde(default)]
    providers: Vec<OpenCodeProvider>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeAuthMethod {
    #[serde(rename = "type")]
    kind: String,
    label: String,
    #[serde(default)]
    prompts: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeAuthorization {
    url: Option<String>,
    method: String,
    instructions: Option<String>,
    user_code: Option<String>,
    #[serde(default)]
    prompts: Option<Vec<Value>>,
}

#[async_trait]
pub trait SandboxApi: Send + Sync + 'static {
    async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError>;
    async fn create(
        &self,
        id: &str,
        request: &CreateRequest,
        sandbox_env: &[(String, String)],
    ) -> Result<Session, ServiceError>;
    async fn suspend(&self, id: &str) -> Result<(), ServiceError>;
    async fn resume(&self, id: &str) -> Result<(), ServiceError>;
    async fn delete(&self, id: &str) -> Result<(), ServiceError>;
    async fn get(&self, id: &str) -> Result<DynamicObject, ServiceError> {
        self.list()
            .await?
            .into_iter()
            .find(|o| o.name_any() == format!("anvil-{id}"))
            .ok_or(ServiceError::NotFound)
    }
    async fn set_opencode_session(&self, _id: &str, _oc: &str) -> Result<(), ServiceError> {
        Ok(())
    }
    async fn set_model(&self, _id: &str, _model: &str) -> Result<(), ServiceError> {
        Ok(())
    }
    async fn set_ready_at(&self, _id: &str, _at: &str) -> Result<(), ServiceError> {
        Ok(())
    }
    async fn set_work_state(
        &self,
        _id: &str,
        _state: &WorkStateRecord,
    ) -> Result<(), ServiceError> {
        Ok(())
    }
    async fn set_binding_state(
        &self,
        _id: &str,
        _state: &BindingStateRecord,
    ) -> Result<(), ServiceError> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct WorkStateRecord {
    pub state: WorkState,
    pub changed_at: String,
    pub summary: Option<String>,
    pub run_id: Option<String>,
    pub current_run: Option<Run>,
    pub last_run: Option<Run>,
}

#[derive(Debug, Clone)]
pub struct BindingStateRecord {
    pub state: String,
    pub continuity: String,
    pub checked_at: String,
    pub error: Option<String>,
    pub previous_session_id: Option<String>,
    pub recovery_event: Option<String>,
}

pub struct KubeSandboxApi {
    client: Client,
    config: Config,
}
impl KubeSandboxApi {
    pub async fn new(config: Config) -> Result<Self, ServiceError> {
        Ok(Self {
            client: Client::try_default()
                .await
                .map_err(|e| ServiceError::Kubernetes(e.to_string()))?,
            config,
        })
    }
}
fn ar(kind: &str, plural: &str, group: &str, version: &str) -> ApiResource {
    ApiResource {
        group: group.into(),
        version: version.into(),
        api_version: if group.is_empty() {
            version.into()
        } else {
            format!("{group}/{version}")
        },
        kind: kind.into(),
        plural: plural.into(),
    }
}
fn sandbox_resource() -> ApiResource {
    ar("Sandbox", "sandboxes", "agents.x-k8s.io", "v1beta1")
}

fn annotation_key(config: &Config, name: &str) -> String {
    format!("{}/{}", config.annotation_prefix, name)
}

fn parse_work_state(value: Option<&String>) -> WorkState {
    value
        .and_then(|value| value.parse().ok())
        .unwrap_or(WorkState::InProgress)
}

fn environment_state(phase: Option<&str>, suspended: bool) -> &'static str {
    if suspended {
        "suspended"
    } else if phase.is_some_and(|phase| phase.eq_ignore_ascii_case("failed")) {
        "failed"
    } else if phase.is_some_and(|phase| phase.eq_ignore_ascii_case("ready")) {
        "ready"
    } else {
        "provisioning"
    }
}

fn condition_indicates_failure(condition: &Value) -> bool {
    let status = condition.get("status").and_then(Value::as_str);
    let condition_type = condition.get("type").and_then(Value::as_str);
    let reason = condition
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let message = condition
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    (condition_type == Some("Failed") && status == Some("True"))
        || reason.contains("fail")
        || reason.contains("error")
        || message.contains("fail")
        || message.contains("error")
}

fn sandbox_environment(o: &DynamicObject, suspended: bool) -> (&'static str, Option<String>) {
    if suspended {
        return ("suspended", None);
    }
    let status = o.data.get("status");
    let conditions = status
        .and_then(|value| value.get("conditions"))
        .and_then(Value::as_array);
    if conditions.is_some_and(|conditions| conditions.iter().any(condition_indicates_failure)) {
        return ("failed", Some("Failed".into()));
    }
    if conditions.is_some_and(|conditions| {
        conditions.iter().any(|condition| {
            condition.get("type").and_then(Value::as_str) == Some("Ready")
                && condition.get("status").and_then(Value::as_str) == Some("True")
        })
    }) {
        return ("ready", Some("Ready".into()));
    }
    let phase = status
        .and_then(|value| value.get("phase"))
        .and_then(Value::as_str);
    (environment_state(phase, false), phase.map(str::to_owned))
}

fn annotation_time_millis(value: &str) -> Option<i64> {
    let raw = value.strip_suffix('Z').unwrap_or(value);
    if let Ok(number) = raw.parse::<i64>() {
        return Some(if raw.len() <= 11 {
            number.saturating_mul(1_000)
        } else {
            number
        });
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn provisioning_timeout_reason(
    object: &DynamicObject,
    config: &Config,
    timeout: Duration,
) -> Option<String> {
    let created_at = object
        .annotations()
        .get(&annotation_key(config, "created-at"))?;
    let created = annotation_time_millis(created_at)?;
    let deadline = created.saturating_add(timeout.as_millis().try_into().ok()?);
    (Utc::now().timestamp_millis() >= deadline).then(|| {
        format!(
            "Sandbox has not reported Ready within {} seconds of creation",
            timeout.as_secs()
        )
    })
}

fn run_annotation(value: Option<&String>) -> Option<Run> {
    value.and_then(|value| serde_json::from_str(value).ok())
}

fn work_state_record(o: &DynamicObject, config: &Config) -> WorkStateRecord {
    let annotations = o.annotations();
    WorkStateRecord {
        state: parse_work_state(annotations.get(&annotation_key(config, "work-state"))),
        changed_at: annotations
            .get(&annotation_key(config, "work-state-changed-at"))
            .cloned()
            .or_else(|| {
                annotations
                    .get(&annotation_key(config, "created-at"))
                    .cloned()
            })
            .unwrap_or_else(chrono_like_now),
        summary: annotations
            .get(&annotation_key(config, "work-state-summary"))
            .cloned(),
        run_id: annotations
            .get(&annotation_key(config, "work-state-run-id"))
            .cloned(),
        current_run: run_annotation(annotations.get(&annotation_key(config, "run-current"))),
        last_run: run_annotation(annotations.get(&annotation_key(config, "run-last"))),
    }
}

fn run_value(run: Option<&Run>) -> Value {
    run.map_or(Value::Null, |run| {
        serde_json::to_string(run)
            .map(Value::String)
            .unwrap_or(Value::Null)
    })
}

fn work_state_annotations(
    config: &Config,
    state: &WorkStateRecord,
) -> serde_json::Map<String, Value> {
    let mut annotations = serde_json::Map::new();
    annotations.insert(
        annotation_key(config, "work-state"),
        Value::String(state.state.as_str().into()),
    );
    annotations.insert(
        annotation_key(config, "work-state-changed-at"),
        Value::String(state.changed_at.clone()),
    );
    annotations.insert(
        annotation_key(config, "work-state-summary"),
        state.summary.clone().map_or(Value::Null, Value::String),
    );
    annotations.insert(
        annotation_key(config, "work-state-run-id"),
        state.run_id.clone().map_or(Value::Null, Value::String),
    );
    annotations.insert(
        annotation_key(config, "run-current"),
        run_value(state.current_run.as_ref()),
    );
    annotations.insert(
        annotation_key(config, "run-last"),
        run_value(state.last_run.as_ref()),
    );
    annotations
}

fn binding_state_record(o: &DynamicObject, config: &Config) -> BindingStateRecord {
    let annotations = o.annotations();
    BindingStateRecord {
        state: annotations
            .get(&annotation_key(config, "binding-state"))
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        continuity: annotations
            .get(&annotation_key(config, "binding-continuity"))
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        checked_at: annotations
            .get(&annotation_key(config, "binding-checked-at"))
            .cloned()
            .or_else(|| {
                annotations
                    .get(&annotation_key(config, "created-at"))
                    .cloned()
            })
            .unwrap_or_else(chrono_like_now),
        error: annotations
            .get(&annotation_key(config, "binding-error"))
            .cloned(),
        previous_session_id: annotations
            .get(&annotation_key(config, "binding-previous-session-id"))
            .cloned(),
        recovery_event: annotations
            .get(&annotation_key(config, "binding-recovery-event"))
            .cloned(),
    }
}

fn labels() -> Value {
    json!({MANAGED:"anvil", APP:"sandbox"})
}
fn session_from(o: &DynamicObject, config: &Config) -> Result<Session, ServiceError> {
    let a = o.annotations();
    let id = o
        .name_any()
        .strip_prefix("anvil-")
        .map(str::to_owned)
        .ok_or(ServiceError::NotFound)?;
    let work = work_state_record(o, config);
    let binding = binding_state_record(o, config);
    let suspended = o
        .data
        .get("spec")
        .and_then(|value| value.get("operatingMode"))
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.eq_ignore_ascii_case("suspended"));
    let (mut environment_state, phase) = sandbox_environment(o, suspended);
    let environment_error = if environment_state == "provisioning" {
        provisioning_timeout_reason(o, config, config.request_timeout)
    } else {
        None
    };
    if environment_error.is_some() {
        environment_state = "failed";
    }
    Ok(Session {
        id,
        sandbox: o.name_any(),
        service: o
            .data
            .get("status")
            .and_then(|v| v.get("serviceFQDN"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        namespace: config.namespace.clone(),
        opencode_port: config.opencode_port,
        phase,
        project: a
            .get(&annotation_key(config, "project"))
            .cloned()
            .unwrap_or_default(),
        repository: a
            .get(&annotation_key(config, "repository"))
            .cloned()
            .unwrap_or_default(),
        base_ref: a
            .get(&annotation_key(config, "base-ref"))
            .cloned()
            .unwrap_or_default(),
        work_branch: a
            .get(&annotation_key(config, "work-branch"))
            .cloned()
            .unwrap_or_default(),
        model: a.get(&annotation_key(config, "model")).cloned(),
        opencode_session_id: a
            .get(&annotation_key(config, "opencode-session-id"))
            .cloned(),
        created_at: a
            .get(&annotation_key(config, "created-at"))
            .cloned()
            .or_else(|| {
                o.data
                    .get("metadata")
                    .and_then(|value| value.get("creationTimestamp"))
                    .and_then(Value::as_str)
                    .map(String::from)
            }),
        ready_at: a.get(&annotation_key(config, "ready-at")).cloned(),
        environment_state: environment_state.into(),
        environment_error,
        work_state: work.state.as_str().into(),
        work_state_changed_at: Some(work.changed_at),
        work_state_summary: work.summary,
        work_state_run_id: work.run_id,
        current_run: work.current_run,
        last_run: work.last_run,
        session_binding_state: binding.state,
        session_binding_continuity: binding.continuity,
        session_binding_error: binding.error,
        session_binding_checked_at: Some(binding.checked_at),
        previous_opencode_session_id: binding.previous_session_id,
        session_binding_recovery_event: binding.recovery_event,
    })
}
#[async_trait]
impl SandboxApi for KubeSandboxApi {
    async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError> {
        Api::<DynamicObject>::namespaced_with(
            self.client.clone(),
            &self.config.namespace,
            &sandbox_resource(),
        )
        .list(&ListParams::default().labels(&format!("{MANAGED}=anvil")))
        .await
        .map(|x| x.items)
        .map_err(|e| ServiceError::Kubernetes(e.to_string()))
    }
    async fn create(
        &self,
        id: &str,
        r: &CreateRequest,
        sandbox_env: &[(String, String)],
    ) -> Result<Session, ServiceError> {
        let ns = &self.config.namespace;
        let name = format!("anvil-{id}");
        let now = chrono_like_now();
        let run_id = new_run_id();
        let initial_run = Run {
            id: run_id.clone(),
            state: "running".into(),
            started_at: now.clone(),
            finished_at: None,
        };
        let l = labels();
        let work_branch = branch_name(&SessionId::parse(id).unwrap());
        let mut annotations = serde_json::Map::new();
        annotations.insert(
            annotation_key(&self.config, "project"),
            Value::String(r.project.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "repository"),
            Value::String(r.repository.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "base-ref"),
            Value::String(r.base_ref.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "work-branch"),
            Value::String(work_branch.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "created-at"),
            Value::String(now.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "runtime-layout"),
            Value::String(RUNTIME_LAYOUT.into()),
        );
        annotations.insert(
            annotation_key(&self.config, "work-state"),
            Value::String(WorkState::InProgress.as_str().into()),
        );
        annotations.insert(
            annotation_key(&self.config, "work-state-changed-at"),
            Value::String(now.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "work-state-run-id"),
            Value::String(run_id.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "run-current"),
            Value::String(serde_json::to_string(&initial_run).unwrap()),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-state"),
            Value::String("pending".into()),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-continuity"),
            Value::String("exact".into()),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-checked-at"),
            Value::String(now.clone()),
        );
        if let Some(model) = &r.model {
            annotations.insert(
                annotation_key(&self.config, "model"),
                Value::String(model.clone()),
            );
        }
        // The prompt is kept in Anvil's append-only history, never in Kubernetes metadata.
        let mut env = vec![
            json!({"name":"ANVIL_PROJECT","value":r.project}),
            json!({"name":"ANVIL_REPOSITORY","value":r.repository}),
            json!({"name":"ANVIL_REF","value":r.base_ref}),
            json!({"name":"ANVIL_WORK_BRANCH","value":work_branch}),
            json!({"name":"ANVIL_RUN_ID","value":run_id}),
            json!({"name":"OPENCODE_CONFIG","value":"/anvil/profile/config/opencode.jsonc"}),
            json!({"name":"OPENCODE_CONFIG_DIR","value":"/anvil/profile/config"}),
            json!({"name":"OPENCODE_DISABLE_CHANNEL_DB","value":"1"}),
            json!({"name":"HOME","value":"/home/anvil"}),
            json!({"name":"XDG_CONFIG_HOME","value":"/home/anvil/.config"}),
            json!({"name":"XDG_CACHE_HOME","value":"/home/anvil/.cache"}),
            json!({"name":"XDG_DATA_HOME","value":"/home/anvil/.local/share"}),
            json!({"name":"XDG_STATE_HOME","value":"/home/anvil/.local/state"}),
            json!({"name":"XDG_RUNTIME_DIR","value":"/home/anvil/.local/state/runtime"}),
            json!({"name":"DISPLAY","value":":99"}),
        ];
        env.extend(
            sandbox_env
                .iter()
                .map(|(name, value)| json!({"name":name,"value":value})),
        );
        let workspace_init = json!({
            "name": "fix-workspace-permissions",
            "image": self.config.image,
            "command": ["/bin/bash", "-c"],
            "args": [
                  "set -euo pipefail\nmkdir -p /home/anvil/workspace/\"$ANVIL_PROJECT\" /home/anvil/.config /home/anvil/.cache /home/anvil/.local/share /home/anvil/.local/state/runtime\nchown -R 1000:1000 /home/anvil"
            ],
            "env": [{"name": "ANVIL_PROJECT", "value": r.project}],
            "securityContext": {"runAsUser": 0, "runAsGroup": 0},
            "volumeMounts": [{"name": "workspace", "mountPath": "/home/anvil"}]
        });
        let container = json!({"name":"sandbox","image":self.config.image,"ports":[{"name":"opencode","containerPort":self.config.opencode_port}],"env":env,"volumeMounts":[{"name":"workspace","mountPath":"/home/anvil"},{"name":"shared-profile","mountPath":"/anvil/profile"}]});
        let obj = json!({"apiVersion":"agents.x-k8s.io/v1beta1","kind":"Sandbox","metadata":{"name":name,"namespace":ns,"labels":l,"annotations":annotations},"spec":{"service":true,"podTemplate":{"spec":{"securityContext":{"fsGroup":1000},"initContainers":[workspace_init],"containers":[container],"volumes":[{"name":"shared-profile","persistentVolumeClaim":{"claimName":self.config.profile_pvc}}]}},"volumeClaimTemplates":[{"metadata":{"name":"workspace"},"spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":self.config.workspace_size}}}}]}});
        Api::<DynamicObject>::namespaced_with(self.client.clone(), ns, &sandbox_resource())
            .create(
                &PostParams::default(),
                &serde_json::from_value(obj).unwrap(),
            )
            .await
            .map_err(|e| ServiceError::Kubernetes(e.to_string()))?;
        Ok(Session {
            id: id.into(),
            sandbox: name,
            service: String::new(),
            namespace: ns.clone(),
            opencode_port: self.config.opencode_port,
            phase: None,
            project: r.project.clone(),
            repository: r.repository.clone(),
            base_ref: r.base_ref.clone(),
            work_branch: branch_name(&SessionId::parse(id).unwrap()),
            model: r.model.clone(),
            opencode_session_id: None,
            created_at: Some(now.clone()),
            ready_at: None,
            environment_state: "provisioning".into(),
            environment_error: None,
            work_state: WorkState::InProgress.as_str().into(),
            work_state_changed_at: Some(initial_run.started_at.clone()),
            work_state_summary: None,
            work_state_run_id: Some(initial_run.id.clone()),
            current_run: Some(initial_run),
            last_run: None,
            session_binding_state: "pending".into(),
            session_binding_continuity: "exact".into(),
            session_binding_error: None,
            session_binding_checked_at: Some(now.clone()),
            previous_opencode_session_id: None,
            session_binding_recovery_event: None,
        })
    }
    async fn suspend(&self, id: &str) -> Result<(), ServiceError> {
        self.patch(id, json!({"spec":{"operatingMode":"Suspended"}}))
            .await
    }
    async fn resume(&self, id: &str) -> Result<(), ServiceError> {
        self.patch(id, json!({"spec":{"operatingMode":"Running"}}))
            .await
    }
    async fn delete(&self, id: &str) -> Result<(), ServiceError> {
        Api::<DynamicObject>::namespaced_with(
            self.client.clone(),
            &self.config.namespace,
            &sandbox_resource(),
        )
        .delete(&format!("anvil-{id}"), &DeleteParams::default())
        .await
        .map(|_| ())
        .map_err(|e| ServiceError::Kubernetes(e.to_string()))
    }
    async fn get(&self, id: &str) -> Result<DynamicObject, ServiceError> {
        Api::<DynamicObject>::namespaced_with(
            self.client.clone(),
            &self.config.namespace,
            &sandbox_resource(),
        )
        .get(&format!("anvil-{id}"))
        .await
        .map_err(|e| ServiceError::Kubernetes(e.to_string()))
    }
    async fn set_opencode_session(&self, id: &str, oc: &str) -> Result<(), ServiceError> {
        let mut annotations = serde_json::Map::new();
        annotations.insert(
            annotation_key(&self.config, "opencode-session-id"),
            Value::String(oc.to_owned()),
        );
        self.patch(id, json!({"metadata":{"annotations":annotations}}))
            .await
    }
    async fn set_model(&self, id: &str, model: &str) -> Result<(), ServiceError> {
        let mut annotations = serde_json::Map::new();
        annotations.insert(
            annotation_key(&self.config, "model"),
            Value::String(model.to_owned()),
        );
        self.patch(id, json!({"metadata":{"annotations":annotations}}))
            .await
    }
    async fn set_ready_at(&self, id: &str, at: &str) -> Result<(), ServiceError> {
        let mut annotations = serde_json::Map::new();
        annotations.insert(
            annotation_key(&self.config, "ready-at"),
            Value::String(at.to_owned()),
        );
        self.patch(id, json!({"metadata":{"annotations":annotations}}))
            .await
    }
    async fn set_work_state(&self, id: &str, state: &WorkStateRecord) -> Result<(), ServiceError> {
        let annotations = work_state_annotations(&self.config, state);
        self.patch(id, json!({"metadata":{"annotations":annotations}}))
            .await
    }
    async fn set_binding_state(
        &self,
        id: &str,
        state: &BindingStateRecord,
    ) -> Result<(), ServiceError> {
        let mut annotations = serde_json::Map::new();
        annotations.insert(
            annotation_key(&self.config, "binding-state"),
            Value::String(state.state.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-continuity"),
            Value::String(state.continuity.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-checked-at"),
            Value::String(state.checked_at.clone()),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-error"),
            state.error.clone().map_or(Value::Null, Value::String),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-previous-session-id"),
            state
                .previous_session_id
                .clone()
                .map_or(Value::Null, Value::String),
        );
        annotations.insert(
            annotation_key(&self.config, "binding-recovery-event"),
            state
                .recovery_event
                .clone()
                .map_or(Value::Null, Value::String),
        );
        self.patch(id, json!({"metadata":{"annotations":annotations}}))
            .await
    }
}
impl KubeSandboxApi {
    async fn patch(&self, id: &str, v: Value) -> Result<(), ServiceError> {
        Api::<DynamicObject>::namespaced_with(
            self.client.clone(),
            &self.config.namespace,
            &sandbox_resource(),
        )
        .patch(
            &format!("anvil-{id}"),
            &PatchParams::default(),
            &Patch::Merge(v),
        )
        .await
        .map(|_| ())
        .map_err(|e| ServiceError::Kubernetes(e.to_string()))
    }
}
fn chrono_like_now() -> String {
    Utc::now().to_rfc3339()
}

fn new_run_id() -> String {
    format!("run_{}", uuid::Uuid::new_v4().simple())
}

fn new_request_id() -> String {
    format!("request_{}", uuid::Uuid::new_v4().simple())
}

#[allow(clippy::too_many_arguments)]
async fn record_history(
    state: &AppState,
    session_id: &str,
    kind: &str,
    at: String,
    request_id: Option<String>,
    prompt: Option<String>,
    origin: Option<&str>,
    run_id: Option<String>,
    detail: Option<String>,
    model: Option<String>,
) {
    if let Err(error) = state
        .history
        .append(HistoryEvent {
            session_id: session_id.into(),
            kind: kind.into(),
            at,
            request_id,
            prompt,
            origin: origin.map(str::to_owned),
            run_id,
            detail,
            model,
        })
        .await
    {
        warn!(session_id, kind, %error, "unable to persist Anvil history event");
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub kube: Arc<dyn SandboxApi>,
    history: HistoryStore,
    profile: ProfileClient,
    pending_logins: Arc<Mutex<HashMap<String, PendingLogin>>>,
    binding_locks: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    capability_signer: Option<github::CapabilitySigner>,
    github: Option<github::GithubBroker>,
}
impl AppState {
    pub fn new<K: SandboxApi>(config: Config, kube: K) -> Self {
        let profile = ProfileClient::new(&config.profile_opencode_url)
            .expect("ANVIL_PROFILE_OPENCODE_URL must be a valid URL");
        let capability_signer = config.session_signing_secret.as_deref().and_then(|secret| {
            github::CapabilitySigner::new(secret, config.session_capability_ttl).ok()
        });
        let github = match (
            config.github_app_id.clone(),
            config.github_installation_id,
            config.github_private_key.clone(),
            reqwest::Url::parse(&config.github_api_url),
        ) {
            (Some(app_id), Some(installation_id), Some(private_key), Ok(api_url)) => {
                Some(github::GithubBroker::new(github::GithubConfig {
                    app_id,
                    installation_id,
                    private_key,
                    api_url,
                }))
            }
            _ => None,
        };
        Self {
            history: HistoryStore::new(config.history_path.clone()),
            config,
            kube: Arc::new(kube),
            profile,
            pending_logins: Arc::new(Mutex::new(HashMap::new())),
            binding_locks: Arc::new(Mutex::new(HashMap::new())),
            capability_signer,
            github,
        }
    }

    fn binding_lock(&self, id: &str) -> Arc<AsyncMutex<()>> {
        self.binding_locks
            .lock()
            .expect("binding lock map poisoned")
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/v1/sessions", post(create).get(enumerate))
        .route("/v1/sessions/:id", get(session).delete(remove))
        .route("/v1/sessions/:id/messages", post(prompt).get(messages))
        .route("/v1/sessions/:id/report", post(report))
        .route("/v1/sessions/:id/report-context", get(report_context))
        .route("/v1/sessions/:id/complete", post(complete))
        .route("/v1/sessions/:id/rebind", post(rebind))
        .route("/v1/sessions/:id/status", get(status))
        .route("/v1/sessions/:id/diff", get(diff))
        .route("/v1/sessions/:id/abort", post(abort))
        .route("/v1/sessions/:id/suspend", post(suspend))
        .route("/v1/sessions/:id/resume", post(resume))
        .route("/v1/sessions/:id/previews/:port", get(preview))
        .route("/v1/sessions/:id/activity", get(activity))
        .route(
            "/v1/sessions/:id/credentials/github",
            post(github_credentials),
        )
        .route("/assets/app.js", get(asset_js))
        .route("/assets/ui-state.js", get(asset_ui_state_js))
        .route("/assets/styles.css", get(asset_css))
        .route("/", get(index))
        .route("/v1/providers", get(providers))
        .route("/v1/providers/:provider/login", post(begin_provider_login))
        .route(
            "/v1/providers/:provider/login/:login_id/complete",
            post(complete_provider_login),
        )
        .route("/v1/opencode/config", get(opencode_config))
        .with_state(state)
}
async fn health() -> Json<Value> {
    Json(json!({"status":"ok"}))
}

async fn index() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../../../web/index.html"),
    )
        .into_response()
}

async fn asset_js() -> Response {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/javascript; charset=utf-8",
        )],
        include_str!("../../../web/app.js"),
    )
        .into_response()
}

async fn asset_ui_state_js() -> Response {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/javascript; charset=utf-8",
        )],
        include_str!("../../../web/ui-state.js"),
    )
        .into_response()
}

async fn asset_css() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../../../web/styles.css"),
    )
        .into_response()
}
async fn ready() -> StatusCode {
    StatusCode::OK
}
async fn create(
    State(s): State<AppState>,
    Json(r): Json<CreateRequest>,
) -> Result<(StatusCode, Json<Session>), ServiceError> {
    let p = Project::new(&r.project).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    Repository::new(&r.repository).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    GitRef::new(&r.base_ref).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    let prompt = Prompt::new(&r.prompt).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    if r.model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty())
    {
        return Err(ServiceError::Invalid("model must not be empty".into()));
    }
    if r.author_name.is_some() != r.author_email.is_some() {
        return Err(ServiceError::Invalid(
            "author_name and author_email must be provided together".into(),
        ));
    }
    let id = SessionId::new(&p).to_string();
    let mut sandbox_env = vec![
        ("ANVIL_SESSION_ID".into(), id.clone()),
        (
            "ANVIL_CREDENTIAL_URL".into(),
            s.config.credential_url.clone(),
        ),
    ];
    if let Some(signer) = &s.capability_signer {
        sandbox_env.push((
            "ANVIL_SESSION_CREDENTIAL".into(),
            signer
                .mint(&id, &r.repository)
                .map_err(ServiceError::Config)?,
        ));
    }
    if let Some(name) = r
        .author_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sandbox_env.push(("ANVIL_GIT_AUTHOR_NAME".into(), name.to_owned()));
    }
    if let Some(email) = r
        .author_email
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sandbox_env.push(("ANVIL_GIT_AUTHOR_EMAIL".into(), email.to_owned()));
    }
    let mut sess = s.kube.create(&id, &r, &sandbox_env).await?;
    record_history(
        &s,
        &id,
        "created",
        chrono_like_now(),
        None,
        None,
        Some("Anvil controller"),
        None,
        None,
        r.model.clone(),
    )
    .await;
    let mut obj = wait_ready(&s, &id).await?;
    let ready_at = chrono_like_now();
    s.kube.set_ready_at(&id, &ready_at).await?;
    record_history(
        &s,
        &id,
        "ready",
        ready_at.clone(),
        None,
        None,
        Some("Anvil controller"),
        None,
        None,
        r.model.clone(),
    )
    .await;
    sess = session_from(&obj, &s.config).unwrap_or(sess);
    sess.ready_at = Some(ready_at);
    let oc = OpenCode::new(service_url(&sess, &s.config), s.config.request_timeout);
    wait_opencode(&oc, s.config.request_timeout).await?;
    let model = match r.model.as_deref() {
        Some(requested) => {
            let model = oc.resolve_model(requested).await?;
            s.kube.set_model(&id, &model.qualified_id()).await?;
            Some(model)
        }
        None => None,
    };
    let oc_id = oc.create_session().await?;
    s.kube.set_opencode_session(&id, &oc_id).await?;
    let recovered = reconcile_binding(&s, &id).await?;
    if !binding_is_usable(&recovered) {
        return Err(ServiceError::Recovery(
            recovered
                .session_binding_error
                .unwrap_or_else(|| "new OpenCode session could not be verified".into()),
        ));
    }
    let request_id = new_request_id();
    record_history(
        &s,
        &id,
        "request_started",
        chrono_like_now(),
        Some(request_id.clone()),
        Some(prompt.as_str().into()),
        Some("Anvil controller"),
        sess.current_run.as_ref().map(|run| run.id.clone()),
        None,
        model.as_ref().map(|model| model.qualified_id()),
    )
    .await;
    if let Err(error) = oc
        .prompt_async(&oc_id, prompt.as_str(), model.as_ref())
        .await
    {
        record_history(
            &s,
            &id,
            "request_failed",
            chrono_like_now(),
            Some(request_id),
            None,
            Some("Anvil controller"),
            None,
            Some(error.to_string()),
            model.as_ref().map(|model| model.qualified_id()),
        )
        .await;
        return Err(error);
    }
    obj = s.kube.get(&id).await?;
    Ok((
        StatusCode::CREATED,
        Json(session_from(&obj, &s.config).unwrap_or_else(|_| {
            sess.opencode_session_id = Some(oc_id);
            sess
        })),
    ))
}

async fn github_credentials(
    Path(id): Path<String>,
    State(s): State<AppState>,
    headers: HeaderMap,
    request: Option<Json<GithubCredentialRequest>>,
) -> Result<Json<github::GithubCredential>, ServiceError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(ServiceError::Unauthorized)?;
    let signer = s.capability_signer.as_ref().ok_or_else(|| {
        ServiceError::Config("GitHub session capabilities are not configured".into())
    })?;
    let claims = signer
        .verify(token)
        .map_err(|_| ServiceError::Unauthorized)?;
    if claims.session_id != id || claims.capability != "github-repository" {
        return Err(ServiceError::Forbidden(
            "capability is not valid for this session".into(),
        ));
    }
    let object = s.kube.get(&id).await?;
    let session = session_from(&object, &s.config)?;
    if session.repository != claims.repository {
        return Err(ServiceError::Forbidden(
            "capability repository does not match session".into(),
        ));
    }
    let broker = s
        .github
        .as_ref()
        .ok_or_else(|| ServiceError::Config("GitHub App credentials are not configured".into()))?;
    broker
        .credential(
            &session.repository,
            request
                .map(|Json(request)| request.purpose)
                .unwrap_or_default(),
        )
        .await
        .map(Json)
        .map_err(ServiceError::Github)
}
async fn wait_ready(s: &AppState, id: &str) -> Result<DynamicObject, ServiceError> {
    let end = tokio::time::Instant::now() + s.config.request_timeout;
    loop {
        let o = s.kube.get(id).await?;
        if o.data
            .get("status")
            .and_then(|v| v.get("conditions"))
            .and_then(Value::as_array)
            .map(|cs| {
                cs.iter().any(|c| {
                    c.get("type").and_then(Value::as_str) == Some("Ready")
                        && c.get("status").and_then(Value::as_str) == Some("True")
                })
            })
            .unwrap_or(false)
        {
            return Ok(o);
        }
        if tokio::time::Instant::now() >= end {
            return Err(ServiceError::Kubernetes(
                "sandbox readiness timed out".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await
    }
}

async fn wait_opencode(opencode: &OpenCode, timeout: Duration) -> Result<(), ServiceError> {
    let deadline = tokio::time::Instant::now() + timeout;
    // A sandbox can be Ready before OpenCode has bound its port. Keep each
    // probe short so a failed early TCP attempt does not consume provisioning.
    let probe = OpenCode::new(opencode.base.to_string(), Duration::from_secs(5));
    loop {
        match probe.health().await {
            Ok(()) => return Ok(()),
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(ServiceError::OpenCode(format!(
                    "OpenCode health timed out: {error}"
                )));
            }
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
fn service_url(sess: &Session, c: &Config) -> String {
    let host = if sess.service.is_empty() {
        format!("anvil-{}", sess.id)
    } else {
        sess.service.clone()
    };
    format!("http://{host}:{}", c.opencode_port)
}

fn binding_is_usable(session: &Session) -> bool {
    matches!(
        session.session_binding_state.as_str(),
        "available" | "rebound"
    )
}

async fn reconcile_binding(s: &AppState, id: &str) -> Result<Session, ServiceError> {
    let lock = s.binding_lock(id);
    let _guard = lock.lock().await;
    let object = s.kube.get(id).await?;
    let session = session_from(&object, &s.config)?;
    let Some(opencode_id) = session.opencode_session_id.as_deref() else {
        return Ok(session);
    };
    let previous = binding_state_record(&object, &s.config);
    let checked_at = chrono_like_now();
    s.kube
        .set_binding_state(
            id,
            &BindingStateRecord {
                state: "recovering".into(),
                continuity: previous.continuity.clone(),
                checked_at: checked_at.clone(),
                error: None,
                previous_session_id: previous.previous_session_id.clone(),
                recovery_event: previous.recovery_event.clone(),
            },
        )
        .await?;
    let op = OpenCode::new(service_url(&session, &s.config), s.config.request_timeout);
    match op.session_exists(opencode_id).await {
        Ok(true) => {
            let state = if previous.state == "rebound" {
                "rebound"
            } else {
                "available"
            };
            s.kube
                .set_binding_state(
                    id,
                    &BindingStateRecord {
                        state: state.into(),
                        continuity: if previous.continuity == "lost" {
                            "lost".into()
                        } else {
                            "exact".into()
                        },
                        checked_at,
                        error: None,
                        previous_session_id: previous.previous_session_id,
                        recovery_event: previous.recovery_event,
                    },
                )
                .await?;
        }
        Ok(false) => {
            let new_id = op.create_session().await?;
            s.kube.set_opencode_session(id, &new_id).await?;
            let recovery_event = format!(
                "OpenCode session {opencode_id} was unavailable; automatically created replacement {new_id}; conversation continuity was lost"
            );
            s.kube
                .set_binding_state(
                    id,
                    &BindingStateRecord {
                        state: "rebound".into(),
                        continuity: "lost".into(),
                        checked_at,
                        error: None,
                        previous_session_id: Some(opencode_id.to_owned()),
                        recovery_event: Some(recovery_event.clone()),
                    },
                )
                .await?;
            record_history(
                s,
                id,
                "conversation_rebound",
                chrono_like_now(),
                None,
                None,
                Some("Anvil controller"),
                None,
                Some(recovery_event),
                session.model.clone(),
            )
            .await;
        }
        Err(error) => {
            s.kube
                .set_binding_state(
                    id,
                    &BindingStateRecord {
                        state: "recovering".into(),
                        continuity: previous.continuity,
                        checked_at,
                        error: Some(error.to_string()),
                        previous_session_id: previous.previous_session_id,
                        recovery_event: previous.recovery_event,
                    },
                )
                .await?;
        }
    }
    session_from(&s.kube.get(id).await?, &s.config)
}

async fn rebind(
    Path(id): Path<String>,
    State(s): State<AppState>,
    Json(request): Json<RecoveryRequest>,
) -> Result<Json<Session>, ServiceError> {
    let prompt = request
        .prompt
        .as_deref()
        .map(|prompt| Prompt::new(prompt).map_err(|error| ServiceError::Invalid(error.to_string())))
        .transpose()?;
    let lock = s.binding_lock(&id);
    let (new_id, model, checked_at) = {
        let _guard = lock.lock().await;
        let session = session_from(&s.kube.get(&id).await?, &s.config)?;
        let old_id = session.opencode_session_id.clone();
        let op = OpenCode::new(service_url(&session, &s.config), s.config.request_timeout);
        wait_opencode(&op, s.config.request_timeout).await?;
        let model = match session.model.as_deref() {
            Some(requested) => Some(op.resolve_model(requested).await?),
            None => None,
        };
        let new_id = op.create_session().await?;
        s.kube.set_opencode_session(&id, &new_id).await?;
        let checked_at = chrono_like_now();
        s.kube
            .set_binding_state(
                &id,
                &BindingStateRecord {
                    state: "rebound".into(),
                    continuity: "lost".into(),
                    checked_at: checked_at.clone(),
                    error: None,
                    previous_session_id: old_id,
                    recovery_event: Some(
                        "OpenCode session rebound; conversation continuity was lost".into(),
                    ),
                },
            )
            .await?;
        (new_id, model, checked_at)
    };
    record_history(
        &s,
        &id,
        "conversation_rebound",
        checked_at,
        None,
        None,
        Some("Anvil controller"),
        None,
        Some("OpenCode conversation rebound; continuity was lost".into()),
        model.as_ref().map(|model| model.qualified_id()),
    )
    .await;
    if let Some(prompt) = prompt {
        let session = session_from(&s.kube.get(&id).await?, &s.config)?;
        let op = OpenCode::new(service_url(&session, &s.config), s.config.request_timeout);
        let request_id = new_request_id();
        record_history(
            &s,
            &id,
            "request_started",
            chrono_like_now(),
            Some(request_id.clone()),
            Some(prompt.as_str().into()),
            Some("Anvil controller"),
            None,
            None,
            model.as_ref().map(|model| model.qualified_id()),
        )
        .await;
        if let Err(error) = op
            .prompt_async(&new_id, prompt.as_str(), model.as_ref())
            .await
        {
            record_history(
                &s,
                &id,
                "request_failed",
                chrono_like_now(),
                Some(request_id),
                None,
                Some("Anvil controller"),
                None,
                Some(error.to_string()),
                model.as_ref().map(|model| model.qualified_id()),
            )
            .await;
            return Err(error);
        }
    }
    Ok(Json(reconcile_binding(&s, &id).await?))
}

async fn enumerate(State(s): State<AppState>) -> Result<Json<Vec<Session>>, ServiceError> {
    let objects = s.kube.list().await?;
    let mut sessions = Vec::with_capacity(objects.len());
    for object in objects {
        if let Ok(session) = session_from(&object, &s.config) {
            sessions.push(reconcile_binding(&s, &session.id).await.unwrap_or(session));
        }
    }
    Ok(Json(sessions))
}
async fn session(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<Session>, ServiceError> {
    Ok(Json(reconcile_binding(&s, &id).await?))
}

async fn activity(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<SessionActivity>, ServiceError> {
    let object = s.kube.get(&id).await?;
    let session = reconcile_binding(&s, &id).await?;
    let operating_mode = object
        .data
        .get("spec")
        .and_then(|value| value.get("operatingMode"))
        .and_then(Value::as_str);
    let messages = if binding_is_usable(&session) {
        let opencode_id = session.opencode_session_id.as_deref().unwrap();
        let op = OpenCode::new(service_url(&session, &s.config), s.config.request_timeout);
        let messages_path = format!("session/{opencode_id}/message");
        let (messages, status) = tokio::join!(
            op.request(&messages_path, reqwest::Method::GET, None),
            op.request("session/status", reqwest::Method::GET, None),
        );
        let messages = messages.unwrap_or_else(|_| Value::Array(Vec::new()));
        let status = status.unwrap_or(Value::Null);
        build_activity(
            &session,
            &session.environment_state,
            operating_mode,
            messages,
            status,
            &s.config,
        )
    } else {
        build_activity(
            &session,
            &session.environment_state,
            operating_mode,
            Value::Array(Vec::new()),
            Value::Null,
            &s.config,
        )
    };
    let history = s.history.for_session(&id).await;
    let mut activity = merge_history(messages, &history);
    if !binding_is_usable(&session) && session.opencode_session_id.is_some() {
        activity.execution_state = "unavailable".into();
        activity.state = "failed".into();
    }
    Ok(Json(activity))
}
async fn suspend(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<StatusCode, ServiceError> {
    s.kube.suspend(&id).await?;
    record_history(
        &s,
        &id,
        "session_suspended",
        chrono_like_now(),
        None,
        None,
        Some("Anvil controller"),
        None,
        None,
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
async fn resume(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<Session>, ServiceError> {
    s.kube.resume(&id).await?;
    let object = wait_ready(&s, &id).await?;
    let session = session_from(&object, &s.config)?;
    let op = OpenCode::new(service_url(&session, &s.config), s.config.request_timeout);
    wait_opencode(&op, s.config.request_timeout).await?;
    let session = reconcile_binding(&s, &id).await?;
    if !binding_is_usable(&session) {
        return Err(ServiceError::Recovery(
            session
                .session_binding_error
                .unwrap_or_else(|| "exact OpenCode session recovery is unavailable".into()),
        ));
    }
    record_history(
        &s,
        &id,
        "session_resumed",
        chrono_like_now(),
        None,
        None,
        Some("Anvil controller"),
        None,
        None,
        None,
    )
    .await;
    Ok(Json(session))
}
async fn remove(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<StatusCode, ServiceError> {
    s.kube.delete(&id).await?;
    record_history(
        &s,
        &id,
        "session_deleted",
        chrono_like_now(),
        None,
        None,
        Some("Anvil controller"),
        None,
        None,
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
async fn prompt(
    Path(id): Path<String>,
    State(s): State<AppState>,
    Json(r): Json<PromptRequest>,
) -> Result<Json<Value>, ServiceError> {
    let p = Prompt::new(&r.prompt).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    let current = reconcile_binding(&s, &id).await?;
    if !binding_is_usable(&current) {
        return Err(ServiceError::Recovery(
            current
                .session_binding_error
                .unwrap_or_else(|| "exact OpenCode session recovery is unavailable".into()),
        ));
    }
    let run_id = begin_run(&s, &id).await?;
    let x = session_from(&s.kube.get(&id).await?, &s.config)?;
    if !binding_is_usable(&x) {
        return Err(ServiceError::Recovery(
            x.session_binding_error
                .unwrap_or_else(|| "exact OpenCode session recovery is unavailable".into()),
        ));
    }
    let oc = OpenCode::new(service_url(&x, &s.config), s.config.request_timeout);
    let model = match x.model.as_deref() {
        Some(requested) => Some(oc.resolve_model(requested).await?),
        None => None,
    };
    let request_id = new_request_id();
    record_history(
        &s,
        &id,
        "request_started",
        chrono_like_now(),
        Some(request_id.clone()),
        Some(p.as_str().into()),
        Some("Anvil controller"),
        Some(run_id),
        None,
        model.as_ref().map(|model| model.qualified_id()),
    )
    .await;
    match oc
        .prompt_async(
            x.opencode_session_id
                .as_deref()
                .ok_or(ServiceError::NotFound)?,
            p.as_str(),
            model.as_ref(),
        )
        .await
    {
        Ok(response) => Ok(Json(response)),
        Err(error) => {
            record_history(
                &s,
                &id,
                "request_failed",
                chrono_like_now(),
                Some(request_id),
                None,
                Some("Anvil controller"),
                None,
                Some(error.to_string()),
                model.as_ref().map(|model| model.qualified_id()),
            )
            .await;
            Err(error)
        }
    }
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ServiceError> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(ServiceError::Unauthorized)
}

async fn authorized_worker_session(
    s: &AppState,
    id: &str,
    headers: &HeaderMap,
) -> Result<DynamicObject, ServiceError> {
    let signer = s
        .capability_signer
        .as_ref()
        .ok_or_else(|| ServiceError::Config("session capabilities are not configured".into()))?;
    let claims = signer
        .verify(bearer_token(headers)?)
        .map_err(|_| ServiceError::Unauthorized)?;
    if claims.session_id != id || claims.capability != "github-repository" {
        return Err(ServiceError::Forbidden(
            "capability is not valid for this session".into(),
        ));
    }
    let object = s.kube.get(id).await?;
    let session = session_from(&object, &s.config)?;
    if session.repository != claims.repository {
        return Err(ServiceError::Forbidden(
            "capability repository does not match session".into(),
        ));
    }
    Ok(object)
}

async fn report_context(
    Path(id): Path<String>,
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ServiceError> {
    let object = authorized_worker_session(&s, &id, &headers).await?;
    let work = work_state_record(&object, &s.config);
    if work.state == WorkState::Completed {
        return Err(ServiceError::Conflict("session is completed".into()));
    }
    let run_id = work
        .run_id
        .ok_or_else(|| ServiceError::Conflict("session has no current run".into()))?;
    Ok(Json(json!({"session_id":id,"run_id":run_id})))
}

async fn report(
    Path(id): Path<String>,
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ReportRequest>,
) -> Result<Json<ReportResponse>, ServiceError> {
    let object = authorized_worker_session(&s, &id, &headers).await?;
    let work = work_state_record(&object, &s.config);
    let disposition = match request.disposition.parse::<WorkerDisposition>() {
        Ok(disposition) => disposition,
        Err(_) => {
            return Err(ServiceError::Invalid(
                "disposition must be ready_for_review or awaiting_input".into(),
            ))
        }
    };
    if work.run_id.as_deref() != Some(request.run_id.as_str()) {
        return Err(ServiceError::Conflict(
            "report run is stale or is not current".into(),
        ));
    }
    let state = validate_worker_transition(work.state, disposition)
        .map_err(|error| ServiceError::Conflict(error.to_string()))?;
    let summary = normalize_summary(request.summary.as_deref())
        .map_err(|error| ServiceError::Invalid(error.to_string()))?;
    let changed_at = chrono_like_now();
    let finished = work.current_run.map(|mut run| {
        run.state = "completed".into();
        run.finished_at = Some(changed_at.clone());
        run
    });
    s.kube
        .set_work_state(
            &id,
            &WorkStateRecord {
                state,
                changed_at: changed_at.clone(),
                summary,
                run_id: Some(request.run_id.clone()),
                current_run: None,
                last_run: finished.or(work.last_run),
            },
        )
        .await?;
    record_history(
        &s,
        &id,
        "worker_reported",
        changed_at.clone(),
        None,
        None,
        Some("Sandbox worker"),
        Some(request.run_id.clone()),
        Some(state.as_str().into()),
        None,
    )
    .await;
    Ok(Json(ReportResponse {
        accepted: true,
        session_id: id,
        run_id: request.run_id,
        work_state: state.as_str().into(),
        work_state_changed_at: changed_at,
    }))
}

async fn complete(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<ReportResponse>, ServiceError> {
    let object = s.kube.get(&id).await?;
    let work = work_state_record(&object, &s.config);
    if work.state != WorkState::ReadyForReview {
        return Err(ServiceError::Conflict(
            "only ready_for_review sessions can be completed".into(),
        ));
    }
    let changed_at = chrono_like_now();
    let run_id = work.run_id.clone().ok_or_else(|| {
        ServiceError::Conflict("session has no run associated with its review state".into())
    })?;
    s.kube
        .set_work_state(
            &id,
            &WorkStateRecord {
                state: WorkState::Completed,
                changed_at: changed_at.clone(),
                summary: work.summary.clone(),
                run_id: Some(run_id.clone()),
                current_run: None,
                last_run: work.last_run,
            },
        )
        .await?;
    record_history(
        &s,
        &id,
        "session_completed",
        changed_at.clone(),
        None,
        None,
        Some("Anvil controller"),
        Some(run_id.clone()),
        None,
        None,
    )
    .await;
    Ok(Json(ReportResponse {
        accepted: true,
        session_id: id,
        run_id,
        work_state: WorkState::Completed.as_str().into(),
        work_state_changed_at: changed_at,
    }))
}

async fn begin_run(s: &AppState, id: &str) -> Result<String, ServiceError> {
    let object = s.kube.get(id).await?;
    let work = work_state_record(&object, &s.config);
    if work.state == WorkState::Completed {
        return Err(ServiceError::Conflict("session is completed".into()));
    }
    let changed_at = chrono_like_now();
    let run = Run {
        id: new_run_id(),
        state: "running".into(),
        started_at: changed_at.clone(),
        finished_at: None,
    };
    let last_run = work.current_run.map(|mut previous| {
        previous.state = "superseded".into();
        previous.finished_at = Some(changed_at.clone());
        previous
    });
    let run_id = run.id.clone();
    s.kube
        .set_work_state(
            id,
            &WorkStateRecord {
                state: WorkState::InProgress,
                changed_at: changed_at.clone(),
                summary: None,
                run_id: Some(run_id.clone()),
                current_run: Some(run),
                last_run: last_run.or(work.last_run),
            },
        )
        .await?;
    record_history(
        s,
        id,
        "run_started",
        changed_at,
        None,
        None,
        Some("Anvil controller"),
        Some(run_id.clone()),
        None,
        None,
    )
    .await;
    Ok(run_id)
}
async fn proxy(
    Path(id): Path<String>,
    State(s): State<AppState>,
    op: &str,
    method: reqwest::Method,
    query: Option<&str>,
) -> Result<Json<Value>, ServiceError> {
    let x = reconcile_binding(&s, &id).await?;
    if !binding_is_usable(&x) {
        return Err(ServiceError::Recovery(
            x.session_binding_error
                .unwrap_or_else(|| "exact OpenCode session recovery is unavailable".into()),
        ));
    }
    Ok(Json(
        OpenCode::new(service_url(&x, &s.config), s.config.request_timeout)
            .request(
                &format!(
                    "session/{}/{}{}",
                    x.opencode_session_id
                        .as_deref()
                        .ok_or(ServiceError::NotFound)?,
                    op,
                    query.map_or_else(String::new, |value| format!("?messageID={value}"))
                ),
                method,
                None,
            )
            .await?,
    ))
}
async fn messages(p: Path<String>, s: State<AppState>) -> Result<Json<Value>, ServiceError> {
    proxy(p, s, "message", reqwest::Method::GET, None).await
}
async fn status(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<Value>, ServiceError> {
    let x = reconcile_binding(&s, &id).await?;
    if !binding_is_usable(&x) {
        return Ok(Json(json!({
            "environment_state": x.environment_state,
            "environment_error": x.environment_error,
            "execution_state": if x.session_binding_state == "missing" { "unavailable" } else { "recovering" },
            "work_state": x.work_state,
            "work_state_changed_at": x.work_state_changed_at,
            "work_state_summary": x.work_state_summary,
            "work_state_run_id": x.work_state_run_id,
            "current_run": x.current_run,
            "last_run": x.last_run,
            "last_activity_at": x.work_state_changed_at,
            "session_binding_state": x.session_binding_state,
            "session_binding_continuity": x.session_binding_continuity,
            "session_binding_error": x.session_binding_error,
            "session_binding_checked_at": x.session_binding_checked_at,
            "previous_opencode_session_id": x.previous_opencode_session_id,
            "session_binding_recovery_event": x.session_binding_recovery_event,
        })));
    }
    let v = OpenCode::new(service_url(&x, &s.config), s.config.request_timeout)
        .request("session/status", reqwest::Method::GET, None)
        .await?;
    let selected = v
        .get(
            &x.opencode_session_id
                .clone()
                .ok_or(ServiceError::NotFound)?,
        )
        .cloned()
        .unwrap_or(Value::Null);
    let execution_state = if status_is_busy(&v, x.opencode_session_id.as_deref().unwrap_or("")) {
        "running"
    } else if selected.get("error").is_some() {
        "failed"
    } else {
        "idle"
    };
    Ok(Json(json!({
        "environment_state": x.environment_state,
        "environment_error": x.environment_error,
        "execution_state": execution_state,
        "work_state": x.work_state,
        "work_state_changed_at": x.work_state_changed_at,
        "work_state_summary": x.work_state_summary,
        "work_state_run_id": x.work_state_run_id,
        "current_run": x.current_run,
        "last_run": x.last_run,
        "last_activity_at": x.work_state_changed_at,
        "session_binding_state": x.session_binding_state,
        "session_binding_continuity": x.session_binding_continuity,
        "session_binding_error": x.session_binding_error,
        "session_binding_checked_at": x.session_binding_checked_at,
        "previous_opencode_session_id": x.previous_opencode_session_id,
        "session_binding_recovery_event": x.session_binding_recovery_event,
        "opencode": selected,
    })))
}
async fn diff(
    p: Path<String>,
    Query(q): Query<DiffQuery>,
    s: State<AppState>,
) -> Result<Json<Value>, ServiceError> {
    proxy(p, s, "diff", reqwest::Method::GET, q.message_id.as_deref()).await
}
async fn abort(p: Path<String>, s: State<AppState>) -> Result<Json<Value>, ServiceError> {
    proxy(p, s, "abort", reqwest::Method::POST, None).await
}
async fn preview(
    Path((id, port)): Path<(String, u16)>,
    State(s): State<AppState>,
) -> Result<Json<Value>, ServiceError> {
    let sid =
        SessionId::parse(&id).ok_or_else(|| ServiceError::Invalid("invalid session id".into()))?;
    let port = Port::new(port).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    Ok(Json(
        json!({"url":format!("https://{}",preview_hostname(&sid,port,&s.config.preview_domain).map_err(|e|ServiceError::Invalid(e.to_string()))?)}),
    ))
}

fn timestamp_from_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value).map(|time| time.to_rfc3339())
}

fn timestamp_from_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Number(number)) => {
            number.as_i64().and_then(timestamp_from_millis).or_else(|| {
                number
                    .as_u64()
                    .and_then(|value| timestamp_from_millis(value as i64))
            })
        }
        Some(Value::String(value)) => {
            if let Ok(number) = value.parse::<i64>() {
                return timestamp_from_millis(if value.len() <= 11 {
                    number.saturating_mul(1000)
                } else {
                    number
                });
            }
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|time| time.with_timezone(&Utc).to_rfc3339())
        }
        _ => None,
    }
}

fn timestamp_millis(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_u64().map(|v| v as i64)),
        Some(Value::String(value)) => value.parse().ok(),
        _ => None,
    }
}

fn message_items(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::Object(object) => object
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn text_parts(message: &Value) -> String {
    message
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn assistant_for<'a>(messages: &'a [Value], parent_id: &str) -> Option<&'a Value> {
    messages
        .iter()
        .filter(|message| {
            let info = message.get("info").unwrap_or(message);
            info.get("role").and_then(Value::as_str) == Some("assistant")
                && info.get("parentID").and_then(Value::as_str) == Some(parent_id)
        })
        .max_by_key(|message| {
            let info = message.get("info").unwrap_or(message);
            timestamp_millis(info.get("time").and_then(|time| time.get("created")))
                .unwrap_or_default()
        })
}

fn assistant_operation(message: &Value) -> Option<String> {
    let parts = message.get("parts")?.as_array()?;
    parts.iter().rev().find_map(|part| {
        if part.get("type").and_then(Value::as_str) != Some("tool") {
            return None;
        }
        let state = part.get("state")?;
        if !matches!(
            state.get("status").and_then(Value::as_str),
            Some("running" | "pending")
        ) {
            return None;
        }
        state
            .get("title")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| {
                part.get("tool")
                    .and_then(Value::as_str)
                    .map(|tool| format!("Running {tool}"))
            })
    })
}

fn assistant_last_activity(message: &Value) -> Option<String> {
    let info = message.get("info").unwrap_or(message);
    let mut latest = timestamp_millis(info.get("time").and_then(|time| time.get("created")));
    if let Some(parts) = message.get("parts").and_then(Value::as_array) {
        for part in parts {
            let candidate = part
                .get("state")
                .and_then(|state| state.get("time"))
                .and_then(|time| time.get("end").or_else(|| time.get("start")))
                .and_then(|value| timestamp_millis(Some(value)));
            latest = latest.max(candidate);
        }
    }
    latest.and_then(timestamp_from_millis)
}

fn assistant_error(message: &Value) -> Option<String> {
    let info = message.get("info").unwrap_or(message);
    let error = info.get("error")?;
    error
        .get("data")
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .or_else(|| error.get("message").and_then(Value::as_str))
        .map(String::from)
        .or_else(|| Some(error.to_string()))
}

fn status_is_busy(status: &Value, session_id: &str) -> bool {
    status
        .get(session_id)
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("busy")
}

fn execution_state(
    status: &Value,
    session_id: Option<&str>,
    requests: &[SessionRequest],
) -> &'static str {
    if session_id.is_some_and(|id| status_is_busy(status, id))
        || requests
            .last()
            .is_some_and(|request| request.state == "running")
    {
        "running"
    } else if requests
        .last()
        .is_some_and(|request| request.state == "failed")
    {
        "failed"
    } else {
        "idle"
    }
}

fn build_activity(
    session: &Session,
    _phase: &str,
    operating_mode: Option<&str>,
    raw_messages: Value,
    status: Value,
    config: &Config,
) -> SessionActivity {
    let messages = message_items(raw_messages);
    let user_messages = messages
        .iter()
        .filter(|message| {
            let info = message.get("info").unwrap_or(message);
            info.get("role").and_then(Value::as_str) == Some("user")
        })
        .collect::<Vec<_>>();
    let busy = session
        .opencode_session_id
        .as_deref()
        .is_some_and(|id| status_is_busy(&status, id));
    let mut requests = Vec::with_capacity(user_messages.len());
    let mut lifecycle = Vec::new();

    if let Some(at) = session.created_at.clone() {
        lifecycle.push(LifecycleEvent {
            kind: "created".into(),
            at,
            detail: Some(format!(
                "Repository: {} · Branch: {}",
                session.project, session.work_branch
            )),
        });
    }
    if let Some(at) = session.ready_at.clone() {
        lifecycle.push(LifecycleEvent {
            kind: "ready".into(),
            at,
            detail: Some("Sandbox environment ready".into()),
        });
    }

    for (index, message) in user_messages.iter().enumerate() {
        let info = message.get("info").unwrap_or(message);
        let id = info
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("request")
            .to_owned();
        let started_at =
            timestamp_from_value(info.get("time").and_then(|time| time.get("created")))
                .unwrap_or_else(|| session.created_at.clone().unwrap_or_default());
        let assistant = assistant_for(&messages, &id);
        let assistant_info = assistant.map(|value| value.get("info").unwrap_or(value));
        let completed_at = assistant_info.and_then(|value| {
            timestamp_from_value(value.get("time").and_then(|time| time.get("completed")))
        });
        let started_ms = timestamp_millis(info.get("time").and_then(|time| time.get("created")));
        let completed_ms = assistant_info.and_then(|value| {
            timestamp_millis(value.get("time").and_then(|time| time.get("completed")))
        });
        let error = assistant.and_then(assistant_error);
        let state = if error.is_some() {
            "failed"
        } else if completed_at.is_some() {
            "completed"
        } else {
            "running"
        };
        let operation = assistant.and_then(assistant_operation);
        let last_activity_at = assistant
            .and_then(assistant_last_activity)
            .or_else(|| Some(started_at.clone()));
        let request = SessionRequest {
            id: id.clone(),
            number: (index + 1) as u32,
            origin: "Anvil controller".into(),
            prompt: text_parts(message),
            state: state.into(),
            started_at: started_at.clone(),
            completed_at: completed_at.clone(),
            duration_ms: started_ms
                .and_then(|start| completed_ms.map(|end| end.saturating_sub(start) as u64)),
            last_activity_at: last_activity_at.clone(),
            current_operation: operation.clone(),
            provider: assistant_info
                .and_then(|value| value.get("providerID"))
                .and_then(Value::as_str)
                .map(String::from),
            model: assistant_info
                .and_then(|value| value.get("modelID"))
                .and_then(Value::as_str)
                .map(String::from),
            error: error.clone(),
        };
        lifecycle.push(LifecycleEvent {
            kind: "request_started".into(),
            at: started_at,
            detail: Some(format!(
                "Request #{} started by {}",
                index + 1,
                request.origin
            )),
        });
        if let Some(completed_at) = completed_at {
            lifecycle.push(LifecycleEvent {
                kind: if error.is_some() {
                    "request_failed"
                } else {
                    "request_completed"
                }
                .into(),
                at: completed_at,
                detail: error,
            });
        }
        requests.push(request);
    }

    let current = requests.last().filter(|request| request.state == "running");
    let request_state = requests.last().map_or_else(
        || "idle".into(),
        |request| {
            if request.state == "failed" {
                "failed".into()
            } else if request.state == "running" {
                "running".into()
            } else {
                "idle".into()
            }
        },
    );
    let state = if operating_mode == Some("Suspended") {
        "stopped"
    } else if session.environment_state == "failed" {
        "failed"
    } else if session.environment_state != "ready" || session.opencode_session_id.is_none() {
        "starting"
    } else if current.is_some() || busy {
        "active"
    } else if requests
        .last()
        .is_some_and(|request| request.state == "failed")
    {
        "failed"
    } else {
        "idle"
    };
    let current_operation = current.and_then(|request| request.current_operation.clone());
    let last_activity_at = requests
        .last()
        .and_then(|request| request.last_activity_at.clone())
        .or_else(|| session.ready_at.clone())
        .or_else(|| session.created_at.clone());
    let opencode_url = (state != "starting").then(|| {
        preview_hostname(
            &SessionId::parse(&session.id).expect("session IDs are validated by session_from"),
            Port::new(session.opencode_port).expect("configured OpenCode port is non-zero"),
            &config.preview_domain,
        )
        .map(|host| format!("https://{host}"))
        .unwrap_or_default()
    });

    lifecycle.sort_by(|left, right| left.at.cmp(&right.at));
    let environment_state = if operating_mode == Some("Suspended") {
        "suspended"
    } else {
        session.environment_state.as_str()
    };
    let execution_state =
        execution_state(&status, session.opencode_session_id.as_deref(), &requests);
    SessionActivity {
        session: session.clone(),
        state: state.into(),
        request_state,
        current_operation,
        last_activity_at,
        requests,
        lifecycle,
        preview_url: None,
        opencode_url,
        attach_command: format!("anvilctl sessions attach {}", session.id),
        environment_state: environment_state.into(),
        environment_error: session.environment_error.clone(),
        execution_state: execution_state.into(),
        work_state: session.work_state.clone(),
        work_state_changed_at: session.work_state_changed_at.clone(),
        work_state_summary: session.work_state_summary.clone(),
        current_run: session.current_run.clone(),
        last_run: session.last_run.clone(),
        session_binding_state: session.session_binding_state.clone(),
        session_binding_continuity: session.session_binding_continuity.clone(),
        session_binding_error: session.session_binding_error.clone(),
        session_binding_checked_at: session.session_binding_checked_at.clone(),
        previous_opencode_session_id: session.previous_opencode_session_id.clone(),
        session_binding_recovery_event: session.session_binding_recovery_event.clone(),
    }
}

fn merge_history(mut activity: SessionActivity, history: &[HistoryEvent]) -> SessionActivity {
    let mut matched = vec![false; activity.requests.len()];
    for event in history
        .iter()
        .filter(|event| event.kind == "request_started" && event.prompt.is_some())
    {
        let prompt = event.prompt.as_deref().unwrap_or_default();
        if let Some((index, _)) = activity
            .requests
            .iter()
            .enumerate()
            .find(|(index, request)| !matched[*index] && request.prompt == prompt)
        {
            matched[index] = true;
            continue;
        }
        let completion = history.iter().find(|candidate| {
            candidate.request_id == event.request_id
                && matches!(
                    candidate.kind.as_str(),
                    "request_completed" | "request_failed"
                )
        });
        let failed = completion.is_some_and(|event| event.kind == "request_failed");
        activity.requests.push(SessionRequest {
            id: event.request_id.clone().unwrap_or_else(new_request_id),
            number: 0,
            origin: event
                .origin
                .clone()
                .unwrap_or_else(|| "Anvil controller".into()),
            prompt: prompt.into(),
            state: if failed {
                "failed"
            } else if completion.is_some() {
                "completed"
            } else {
                "running"
            }
            .into(),
            started_at: event.at.clone(),
            completed_at: completion.map(|event| event.at.clone()),
            duration_ms: None,
            last_activity_at: completion
                .map(|event| event.at.clone())
                .or_else(|| Some(event.at.clone())),
            current_operation: None,
            provider: None,
            model: event.model.clone(),
            error: completion.and_then(|event| {
                (event.kind == "request_failed").then(|| event.detail.clone().unwrap_or_default())
            }),
        });
        matched.push(true);
    }
    activity
        .requests
        .sort_by(|left, right| left.started_at.cmp(&right.started_at));
    for (index, request) in activity.requests.iter_mut().enumerate() {
        request.number = (index + 1) as u32;
    }
    let matched_history_requests = history
        .iter()
        .filter(|event| event.kind == "request_started")
        .filter_map(|event| {
            event.prompt.as_ref().and_then(|prompt| {
                activity
                    .requests
                    .iter()
                    .any(|request| &request.prompt == prompt)
                    .then(|| event.request_id.clone())
            })
        })
        .flatten()
        .collect::<std::collections::HashSet<_>>();

    let mut lifecycle_keys = activity
        .lifecycle
        .iter()
        .map(|event| {
            format!(
                "{}:{}:{}",
                event.kind,
                event.at,
                event.detail.as_deref().unwrap_or_default()
            )
        })
        .collect::<std::collections::HashSet<_>>();
    for event in history {
        if matches!(
            event.kind.as_str(),
            "request_started" | "request_completed" | "request_failed"
        ) && (event
            .request_id
            .as_ref()
            .is_some_and(|id| matched_history_requests.contains(id))
            || activity
                .requests
                .iter()
                .any(|request| request.id == event.request_id.clone().unwrap_or_default()))
        {
            continue;
        }
        let key = format!(
            "{}:{}:{}",
            event.kind,
            event.at,
            event.detail.as_deref().unwrap_or_default()
        );
        if lifecycle_keys.insert(key) {
            activity.lifecycle.push(LifecycleEvent {
                kind: event.kind.clone(),
                at: event.at.clone(),
                detail: event.detail.clone().or_else(|| event.run_id.clone()),
            });
        }
    }
    activity
        .lifecycle
        .sort_by(|left, right| left.at.cmp(&right.at));
    activity
}

#[derive(Clone)]
struct ProfileClient {
    client: reqwest::Client,
    base: Url,
}

impl ProfileClient {
    fn new(raw: &str) -> Result<Self, ServiceError> {
        let mut base = Url::parse(raw)
            .map_err(|e| ServiceError::Config(format!("invalid profile URL: {e}")))?;
        if !matches!(base.scheme(), "http" | "https") || base.host_str().is_none() {
            return Err(ServiceError::Config(
                "profile URL must be an HTTP(S) URL with a host".into(),
            ));
        }
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            client: reqwest::Client::new(),
            base,
        })
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ServiceError> {
        let url = self
            .base
            .join(path)
            .map_err(|e| ServiceError::Profile(e.to_string()))?;
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| ServiceError::Profile(e.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ServiceError::Profile(e.to_string()))?;
        if !status.is_success() {
            // Never relay an upstream response body: it could contain auth data.
            return Err(ServiceError::Profile(format!("upstream returned {status}")));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|e| ServiceError::Profile(e.to_string()))
    }
}

fn provider_id(value: &str) -> Result<(), ServiceError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        return Err(ServiceError::Invalid("invalid provider id".into()));
    }
    Ok(())
}

async fn profile_methods(
    profile: &ProfileClient,
    provider: &str,
) -> Result<Vec<OpenCodeAuthMethod>, ServiceError> {
    let value = profile
        .request(reqwest::Method::GET, "provider/auth", None)
        .await?;
    let methods = value
        .get(provider)
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    serde_json::from_value(methods).map_err(|e| ServiceError::Profile(e.to_string()))
}

async fn providers(State(s): State<AppState>) -> Result<Json<ProviderListResponse>, ServiceError> {
    let raw: OpenCodeProviderList = serde_json::from_value(
        s.profile
            .request(reqwest::Method::GET, "provider", None)
            .await?,
    )
    .map_err(|e| ServiceError::Profile(e.to_string()))?;
    let auth_methods = s
        .profile
        .request(reqwest::Method::GET, "provider/auth", None)
        .await?;
    let mut result = Vec::with_capacity(raw.all.len());
    for provider in raw.all {
        let methods = auth_methods
            .get(&provider.id)
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let methods: Vec<OpenCodeAuthMethod> =
            serde_json::from_value(methods).map_err(|e| ServiceError::Profile(e.to_string()))?;
        result.push(ProviderSummary {
            authenticated: raw.connected.iter().any(|id| id == &provider.id),
            id: provider.id,
            name: provider.name,
            auth_methods: methods
                .into_iter()
                .map(|method| ProviderAuthMethod {
                    kind: method.kind,
                    label: method.label,
                    prompts: method.prompts,
                })
                .collect(),
            api_key_available: !provider.env.is_empty(),
        });
    }
    Ok(Json(ProviderListResponse { providers: result }))
}

async fn begin_provider_login(
    Path(provider): Path<String>,
    State(s): State<AppState>,
    body: Option<Json<ProviderLoginRequest>>,
) -> Result<Json<LoginFlow>, ServiceError> {
    provider_id(&provider)?;
    let body = body.map(|Json(body)| body).unwrap_or(ProviderLoginRequest {
        method: None,
        inputs: HashMap::new(),
    });
    let raw: OpenCodeProviderList = serde_json::from_value(
        s.profile
            .request(reqwest::Method::GET, "provider", None)
            .await?,
    )
    .map_err(|e| ServiceError::Profile(e.to_string()))?;
    let provider_info = raw
        .all
        .iter()
        .find(|candidate| candidate.id == provider)
        .ok_or(ServiceError::NotFound)?;
    let methods = profile_methods(&s.profile, &provider).await?;
    let selected = body.method.as_deref().and_then(|requested| {
        requested
            .parse::<usize>()
            .ok()
            .or_else(|| {
                methods
                    .iter()
                    .position(|method| method.label.eq_ignore_ascii_case(requested))
            })
            .or_else(|| {
                (requested.eq_ignore_ascii_case("oauth"))
                    .then(|| methods.iter().position(|method| method.kind == "oauth"))
                    .flatten()
            })
    });
    let oauth_method = methods.iter().position(|method| method.kind == "oauth");
    let api_method = methods
        .iter()
        .position(|method| method.kind == "api" || method.kind == "api_key");
    let api_key_available = !provider_info.env.is_empty();
    let requested_api_key = body.method.as_deref().is_some_and(|requested| {
        requested.eq_ignore_ascii_case("api")
            || requested.eq_ignore_ascii_case("api-key")
            || requested.eq_ignore_ascii_case("api_key")
    });
    let selected = selected.or(api_method.filter(|_| requested_api_key));
    let use_api_key = selected
        .and_then(|index| methods.get(index))
        .is_some_and(|method| method.kind == "api" || method.kind == "api_key")
        || (selected.is_none() && requested_api_key)
        || (selected.is_none()
            && body.method.is_none()
            && oauth_method.is_none()
            && api_key_available);
    if use_api_key {
        if !api_key_available {
            return Err(ServiceError::Invalid(format!(
                "provider {provider} does not advertise API-key authentication"
            )));
        }
        let login_id = uuid::Uuid::new_v4().simple().to_string();
        let mut pending = s
            .pending_logins
            .lock()
            .map_err(|_| ServiceError::Profile("login state unavailable".into()))?;
        let now = std::time::Instant::now();
        pending.retain(|_, flow| now.duration_since(flow.created_at) < LOGIN_TTL);
        pending.retain(|_, flow| flow.provider != provider);
        pending.insert(
            login_id.clone(),
            PendingLogin {
                provider: provider.clone(),
                method: PendingLoginMethod::ApiKey,
                created_at: now,
            },
        );
        info!(%provider, %login_id, provider_name = %provider_info.name, "provider API-key login started");
        return Ok(Json(LoginFlow {
            login_id,
            provider,
            state: "awaiting_user".into(),
            verification_url: None,
            user_code: None,
            method: "api_key".into(),
            instructions: Some("An API key is required. The key is never stored by Anvil.".into()),
            prompts: None,
        }));
    }
    let method = selected.or(oauth_method).ok_or_else(|| {
        ServiceError::Invalid(format!(
            "provider {provider} has no supported authentication method"
        ))
    })?;
    let selected_method = methods.get(method).ok_or_else(|| {
        ServiceError::Invalid(format!(
            "invalid authentication method for provider {provider}"
        ))
    })?;
    if selected_method.kind != "oauth" {
        return Err(ServiceError::Invalid(format!(
            "provider {provider} authentication method is not OAuth or API key"
        )));
    }
    let authorization: OpenCodeAuthorization = serde_json::from_value(
        s.profile
            .request(
                reqwest::Method::POST,
                &format!("provider/{provider}/oauth/authorize"),
                Some(json!({"method": method, "inputs": body.inputs})),
            )
            .await?,
    )
    .map_err(|e| ServiceError::Profile(e.to_string()))?;
    let login_id = uuid::Uuid::new_v4().simple().to_string();
    let mut pending = s
        .pending_logins
        .lock()
        .map_err(|_| ServiceError::Profile("login state unavailable".into()))?;
    let now = std::time::Instant::now();
    pending.retain(|_, flow| now.duration_since(flow.created_at) < LOGIN_TTL);
    // OpenCode tracks one pending OAuth callback per provider. Invalidate an
    // older Anvil flow rather than letting two IDs race against that state.
    pending.retain(|_, flow| flow.provider != provider);
    pending.insert(
        login_id.clone(),
        PendingLogin {
            provider: provider.clone(),
            method: PendingLoginMethod::OAuth(method),
            created_at: now,
        },
    );
    info!(%provider, %login_id, provider_name = %provider_info.name, "provider login started");
    Ok(Json(LoginFlow {
        login_id,
        provider,
        state: "awaiting_user".into(),
        verification_url: authorization.url,
        user_code: authorization.user_code,
        method: authorization.method,
        instructions: authorization.instructions,
        prompts: authorization.prompts,
    }))
}

async fn complete_provider_login(
    Path((provider, login_id)): Path<(String, String)>,
    State(s): State<AppState>,
    Json(request): Json<ProviderCompleteRequest>,
) -> Result<Json<ProviderStatus>, ServiceError> {
    provider_id(&provider)?;
    let pending = s
        .pending_logins
        .lock()
        .map_err(|_| ServiceError::Profile("login state unavailable".into()))?
        .get(&login_id)
        .cloned()
        .ok_or(ServiceError::NotFound)?;
    if pending.provider != provider {
        return Err(ServiceError::NotFound);
    }
    if pending.created_at.elapsed() >= LOGIN_TTL {
        s.pending_logins
            .lock()
            .map_err(|_| ServiceError::Profile("login state unavailable".into()))?
            .remove(&login_id);
        return Err(ServiceError::NotFound);
    }
    s.pending_logins
        .lock()
        .map_err(|_| ServiceError::Profile("login state unavailable".into()))?
        .remove(&login_id);
    let completed: bool = match pending.method {
        PendingLoginMethod::OAuth(method) => serde_json::from_value(
            s.profile
                .request(
                    reqwest::Method::POST,
                    &format!("provider/{provider}/oauth/callback"),
                    Some(json!({"method": method, "code": request.code})),
                )
                .await?,
        )
        .map_err(|e| ServiceError::Profile(e.to_string()))?,
        PendingLoginMethod::ApiKey => {
            let key = request
                .key
                .as_deref()
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .ok_or_else(|| ServiceError::Invalid("API key is required".into()))?;
            serde_json::from_value(
                s.profile
                    .request(
                        reqwest::Method::PUT,
                        &format!("auth/{provider}"),
                        Some(json!({"type":"api","key":key})),
                    )
                    .await?,
            )
            .map_err(|e| ServiceError::Profile(e.to_string()))?
        }
    };
    if !completed {
        return Err(ServiceError::Profile(
            "provider authorization failed".into(),
        ));
    }
    info!(%provider, %login_id, "provider login completed");
    Ok(Json(ProviderStatus {
        provider,
        authenticated: true,
    }))
}

async fn opencode_config(State(s): State<AppState>) -> Result<Json<Value>, ServiceError> {
    let value = s
        .profile
        .request(reqwest::Method::GET, "config", None)
        .await?;
    Ok(Json(redact_config(value)))
}

fn redact_config(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    let sensitive = [
                        "key",
                        "token",
                        "secret",
                        "password",
                        "credential",
                        "authorization",
                        "auth",
                    ]
                    .iter()
                    .any(|word| lower.contains(word));
                    (
                        key,
                        if sensitive {
                            Value::String("[redacted]".into())
                        } else {
                            redact_config(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_config).collect()),
        value => value,
    }
}

#[derive(Clone)]
pub struct OpenCode {
    client: reqwest::Client,
    base: Url,
}
impl OpenCode {
    pub fn new(base: String, t: Duration) -> Self {
        Self {
            client: reqwest::Client::builder().timeout(t).build().unwrap(),
            base: Url::parse(&base).unwrap(),
        }
    }
    async fn health(&self) -> Result<(), ServiceError> {
        self.request("global/health", reqwest::Method::GET, None)
            .await
            .map(|_| ())
    }
    async fn session_exists(&self, id: &str) -> Result<bool, ServiceError> {
        match self
            .request(&format!("session/{id}"), reqwest::Method::GET, None)
            .await
        {
            Ok(_) => Ok(true),
            Err(ServiceError::OpenCode(error)) if error.starts_with("HTTP 404 ") => Ok(false),
            Err(error) => Err(error),
        }
    }
    async fn create_session(&self) -> Result<String, ServiceError> {
        let v = self
            .request("session", reqwest::Method::POST, Some(json!({})))
            .await?;
        v.get("id")
            .or_else(|| v.get("sessionID"))
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| ServiceError::OpenCode("session response has no id".into()))
    }
    async fn resolve_model(&self, requested: &str) -> Result<OpenCodeModel, ServiceError> {
        let requested = requested.trim();
        let configured: OpenCodeConfiguredProviders = serde_json::from_value(
            self.request("config/providers", reqwest::Method::GET, None)
                .await?,
        )
        .map_err(|e| ServiceError::OpenCode(format!("invalid provider catalog: {e}")))?;

        let matches = if let Some((provider_id, model_id)) = requested.split_once('/') {
            configured
                .providers
                .iter()
                .filter(|provider| provider.id == provider_id)
                .flat_map(|provider| provider.models.values())
                .filter(|model| model.id == model_id)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            configured
                .providers
                .iter()
                .flat_map(|provider| provider.models.values())
                .filter(|model| model.id == requested)
                .cloned()
                .collect::<Vec<_>>()
        };

        match matches.as_slice() {
            [model] => Ok(model.clone()),
            [] => Err(ServiceError::OpenCode(format!(
                "requested model is unavailable: {requested}"
            ))),
            _ => Err(ServiceError::OpenCode(format!(
                "requested model is ambiguous: {requested}"
            ))),
        }
    }
    async fn prompt_async(
        &self,
        id: &str,
        p: &str,
        model: Option<&OpenCodeModel>,
    ) -> Result<Value, ServiceError> {
        let mut body = json!({"parts":[{"type":"text","text":p}]});
        if let Some(model) = model {
            body["model"] = json!({
                "providerID": model.provider_id,
                "modelID": model.id,
            });
        }
        self.request(
            &format!("session/{id}/prompt_async"),
            reqwest::Method::POST,
            Some(body),
        )
        .await
    }
    async fn request(
        &self,
        path: &str,
        m: reqwest::Method,
        b: Option<Value>,
    ) -> Result<Value, ServiceError> {
        let u = self
            .base
            .join(path)
            .map_err(|e| ServiceError::OpenCode(e.to_string()))?;
        let mut q = self.client.request(m, u);
        if let Some(v) = b {
            q = q.json(&v)
        }
        let r = q
            .send()
            .await
            .map_err(|e| ServiceError::OpenCode(format!("{e:?}")))?;
        let st = r.status();
        let bytes = r
            .bytes()
            .await
            .map_err(|e| ServiceError::OpenCode(e.to_string()))?;
        let v = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|e| ServiceError::OpenCode(e.to_string()))?
        };
        if !st.is_success() {
            warn!(%st,"OpenCode request failed");
            return Err(ServiceError::OpenCode(format!("HTTP {st}: {v}")));
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use httpmock::{Method::GET, MockServer};
    use std::collections::BTreeMap;
    use tower::ServiceExt;

    struct FakeSandbox;

    struct BindingSandbox {
        object: Arc<Mutex<DynamicObject>>,
    }

    struct ActivitySandbox {
        object: DynamicObject,
    }

    struct ReportSandbox {
        object: Arc<Mutex<DynamicObject>>,
    }

    #[async_trait]
    impl SandboxApi for FakeSandbox {
        async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError> {
            Ok(Vec::new())
        }
        async fn create(
            &self,
            _id: &str,
            _request: &CreateRequest,
            _sandbox_env: &[(String, String)],
        ) -> Result<Session, ServiceError> {
            Err(ServiceError::Invalid("not used in provider tests".into()))
        }
        async fn suspend(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }
        async fn resume(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }
        async fn delete(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }
    }

    #[async_trait]
    impl SandboxApi for BindingSandbox {
        async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError> {
            Ok(vec![self
                .object
                .lock()
                .map_err(|_| ServiceError::Kubernetes("test lock poisoned".into()))?
                .clone()])
        }

        async fn create(
            &self,
            _id: &str,
            _request: &CreateRequest,
            _sandbox_env: &[(String, String)],
        ) -> Result<Session, ServiceError> {
            Err(ServiceError::Invalid("not used in binding tests".into()))
        }

        async fn suspend(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn resume(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn delete(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn set_opencode_session(
            &self,
            _id: &str,
            session_id: &str,
        ) -> Result<(), ServiceError> {
            let mut object = self
                .object
                .lock()
                .map_err(|_| ServiceError::Kubernetes("test lock poisoned".into()))?;
            object
                .metadata
                .annotations
                .get_or_insert_with(BTreeMap::new)
                .insert(
                    "anvil.example/opencode-session-id".into(),
                    session_id.into(),
                );
            Ok(())
        }

        async fn set_binding_state(
            &self,
            _id: &str,
            state: &BindingStateRecord,
        ) -> Result<(), ServiceError> {
            let mut object = self
                .object
                .lock()
                .map_err(|_| ServiceError::Kubernetes("test lock poisoned".into()))?;
            let annotations = object
                .metadata
                .annotations
                .get_or_insert_with(BTreeMap::new);
            annotations.insert("anvil.example/binding-state".into(), state.state.clone());
            annotations.insert(
                "anvil.example/binding-continuity".into(),
                state.continuity.clone(),
            );
            if let Some(error) = &state.error {
                annotations.insert("anvil.example/binding-error".into(), error.clone());
            } else {
                annotations.remove("anvil.example/binding-error");
            }
            if let Some(previous) = &state.previous_session_id {
                annotations.insert(
                    "anvil.example/binding-previous-session-id".into(),
                    previous.clone(),
                );
            }
            if let Some(event) = &state.recovery_event {
                annotations.insert("anvil.example/binding-recovery-event".into(), event.clone());
            }
            Ok(())
        }
    }

    #[async_trait]
    impl SandboxApi for ActivitySandbox {
        async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError> {
            Ok(vec![self.object.clone()])
        }

        async fn create(
            &self,
            _id: &str,
            _request: &CreateRequest,
            _sandbox_env: &[(String, String)],
        ) -> Result<Session, ServiceError> {
            Err(ServiceError::Invalid("not used in activity tests".into()))
        }

        async fn suspend(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn resume(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn delete(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }
    }

    #[async_trait]
    impl SandboxApi for ReportSandbox {
        async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError> {
            Ok(vec![self
                .object
                .lock()
                .map_err(|_| ServiceError::Kubernetes("test lock poisoned".into()))?
                .clone()])
        }

        async fn create(
            &self,
            _id: &str,
            _request: &CreateRequest,
            _sandbox_env: &[(String, String)],
        ) -> Result<Session, ServiceError> {
            Err(ServiceError::Invalid("not used in report tests".into()))
        }

        async fn suspend(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn resume(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn delete(&self, _id: &str) -> Result<(), ServiceError> {
            Ok(())
        }

        async fn set_work_state(
            &self,
            _id: &str,
            state: &WorkStateRecord,
        ) -> Result<(), ServiceError> {
            let mut object = self
                .object
                .lock()
                .map_err(|_| ServiceError::Kubernetes("test lock poisoned".into()))?;
            let annotations = object
                .metadata
                .annotations
                .get_or_insert_with(BTreeMap::new);
            annotations.insert(
                "anvil.example/work-state".into(),
                state.state.as_str().into(),
            );
            annotations.insert(
                "anvil.example/work-state-changed-at".into(),
                state.changed_at.clone(),
            );
            if let Some(summary) = &state.summary {
                annotations.insert("anvil.example/work-state-summary".into(), summary.clone());
            } else {
                annotations.remove("anvil.example/work-state-summary");
            }
            if let Some(run_id) = &state.run_id {
                annotations.insert("anvil.example/work-state-run-id".into(), run_id.clone());
            }
            if let Some(run) = &state.current_run {
                annotations.insert(
                    "anvil.example/run-current".into(),
                    serde_json::to_string(run).unwrap(),
                );
            } else {
                annotations.remove("anvil.example/run-current");
            }
            if let Some(run) = &state.last_run {
                annotations.insert(
                    "anvil.example/run-last".into(),
                    serde_json::to_string(run).unwrap(),
                );
            }
            Ok(())
        }
    }

    fn config(profile_opencode_url: String) -> Config {
        Config {
            bind_port: 8080,
            namespace: "anvil".into(),
            image: "sandbox:dev".into(),
            workspace_size: "1Gi".into(),
            opencode_port: 4096,
            request_timeout: Duration::from_secs(5),
            preview_domain: "preview.example.test".into(),
            annotation_prefix: "anvil.example".into(),
            profile_opencode_url,
            profile_pvc: "anvil-opencode-profile".into(),
            credential_url: "http://anvild:8080".into(),
            github_app_id: None,
            github_installation_id: None,
            github_private_key: None,
            session_signing_secret: None,
            session_capability_ttl: Duration::from_secs(86400),
            github_api_url: "https://api.github.com".into(),
            history_path: PathBuf::from("/tmp/anvil-history.jsonl"),
        }
    }

    fn activity_session() -> Session {
        Session {
            id: "demo-12345678".into(),
            sandbox: "anvil-demo-12345678".into(),
            service: "anvil-demo-12345678.anvil.svc".into(),
            namespace: "anvil".into(),
            opencode_port: 4096,
            phase: Some("Ready".into()),
            project: "demo".into(),
            repository: "https://github.com/example/demo.git".into(),
            base_ref: "main".into(),
            work_branch: "anvil/demo-12345678".into(),
            model: None,
            opencode_session_id: Some("ses_demo".into()),
            created_at: Some("2026-01-01T10:00:00Z".into()),
            ready_at: Some("2026-01-01T10:00:41Z".into()),
            environment_state: "ready".into(),
            environment_error: None,
            work_state: "in_progress".into(),
            work_state_changed_at: Some("2026-01-01T10:00:00Z".into()),
            work_state_summary: None,
            work_state_run_id: Some("run_test".into()),
            current_run: Some(Run {
                id: "run_test".into(),
                state: "running".into(),
                started_at: "2026-01-01T10:00:00Z".into(),
                finished_at: None,
            }),
            last_run: None,
            session_binding_state: "available".into(),
            session_binding_continuity: "exact".into(),
            session_binding_error: None,
            session_binding_checked_at: Some("2026-01-01T10:00:41Z".into()),
            previous_opencode_session_id: None,
            session_binding_recovery_event: None,
        }
    }

    #[tokio::test]
    async fn activity_endpoint_returns_read_model_and_embedded_dashboard() {
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "agents.x-k8s.io/v1beta1",
            "kind": "Sandbox",
            "metadata": {
                "name": "anvil-demo-12345678",
                "annotations": {
                    "anvil.example/project": "demo",
                    "anvil.example/repository": "https://github.com/example/demo.git",
                    "anvil.example/base-ref": "main",
                    "anvil.example/work-branch": "anvil/demo-12345678",
                    "anvil.example/created-at": "2026-01-01T10:00:00Z",
                    "anvil.example/ready-at": "2026-01-01T10:00:41Z"
                }
            },
            "status": {"phase": "Ready", "serviceFQDN": "anvil-demo-12345678"}
        }))
        .unwrap();
        let app = router(AppState::new(
            config("http://profile.test".into()),
            ActivitySandbox { object },
        ));
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/sessions/demo-12345678/activity")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["session"]["project"], "demo");
        assert_eq!(body["state"], "starting");
        assert_eq!(body["environment_state"], "ready");
        assert_eq!(
            body["attach_command"],
            "anvilctl sessions attach demo-12345678"
        );
        assert_eq!(body["lifecycle"][0]["kind"], "created");

        let response = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
        );

        let response = app
            .oneshot(
                Request::get("/assets/ui-state.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "text/javascript; charset=utf-8"
        );
    }

    #[test]
    fn provisioning_timeout_is_projected_as_a_problem() {
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "agents.x-k8s.io/v1beta1",
            "kind": "Sandbox",
            "metadata": {
                "name": "anvil-demo-12345678",
                "annotations": {
                    "anvil.example/created-at": "2020-01-01T00:00:00Z"
                }
            },
            "status": {"phase": "Pending"}
        }))
        .unwrap();
        let reason = provisioning_timeout_reason(
            &object,
            &config("http://profile.test".into()),
            Duration::from_secs(5),
        );
        assert_eq!(
            reason.as_deref(),
            Some("Sandbox has not reported Ready within 5 seconds of creation")
        );
    }

    #[tokio::test]
    async fn history_is_read_back_after_store_recreation() {
        let path =
            std::env::temp_dir().join(format!("anvil-history-{}.jsonl", uuid::Uuid::new_v4()));
        let store = HistoryStore::new(path.clone());
        store
            .append(HistoryEvent {
                session_id: "demo-12345678".into(),
                kind: "request_started".into(),
                at: "2026-01-01T10:00:00Z".into(),
                request_id: Some("request_1".into()),
                prompt: Some("Inspect the repository".into()),
                origin: Some("Anvil controller".into()),
                run_id: Some("run_1".into()),
                detail: None,
                model: None,
            })
            .await
            .unwrap();
        let restarted = HistoryStore::new(path.clone());
        let events = restarted.for_session("demo-12345678").await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].prompt.as_deref(), Some("Inspect the repository"));
        let _ = tokio::fs::remove_file(path).await;
    }

    #[test]
    fn merge_history_tracks_requests_added_from_multiple_events() {
        let session: Session = serde_json::from_value(json!({
            "id": "demo-12345678",
            "sandbox": "anvil-demo-12345678",
            "service": "anvil-demo-12345678",
            "namespace": "anvil",
            "opencode_port": 4096,
            "phase": "Ready",
            "project": "demo",
            "repository": "https://github.com/example/demo.git",
            "ref": "main",
            "work_branch": "anvil/demo-12345678",
            "model": "openai/gpt-5.6-luna",
            "environment_state": "ready",
            "work_state": "in_progress"
        }))
        .unwrap();
        let activity = build_activity(
            &session,
            "Ready",
            None,
            json!([]),
            json!({}),
            &config("http://profile.test".into()),
        );
        let history = vec![
            HistoryEvent {
                session_id: session.id.clone(),
                kind: "request_started".into(),
                at: "2026-01-01T10:00:00Z".into(),
                request_id: Some("request_1".into()),
                prompt: Some("first prompt".into()),
                origin: Some("Anvil controller".into()),
                run_id: None,
                detail: None,
                model: Some("openai/gpt-5.6-luna".into()),
            },
            HistoryEvent {
                session_id: session.id,
                kind: "request_started".into(),
                at: "2026-01-01T10:01:00Z".into(),
                request_id: Some("request_2".into()),
                prompt: Some("second prompt".into()),
                origin: Some("Anvil controller".into()),
                run_id: None,
                detail: None,
                model: Some("openai/gpt-5.6-luna".into()),
            },
        ];

        let activity = merge_history(activity, &history);
        assert_eq!(activity.requests.len(), 2);
        assert_eq!(activity.requests[0].prompt, "first prompt");
        assert_eq!(activity.requests[1].prompt, "second prompt");
    }

    #[tokio::test]
    async fn worker_report_is_capability_and_run_bound_and_controller_completes() {
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "agents.x-k8s.io/v1beta1",
            "kind": "Sandbox",
            "metadata": {
                "name": "anvil-demo-12345678",
                "annotations": {
                    "anvil.example/project": "demo",
                    "anvil.example/repository": "https://github.com/example/demo.git",
                    "anvil.example/base-ref": "main",
                    "anvil.example/work-branch": "anvil/demo-12345678",
                    "anvil.example/created-at": "2026-01-01T10:00:00Z",
                    "anvil.example/work-state": "in_progress",
                    "anvil.example/work-state-changed-at": "2026-01-01T10:00:00Z",
                    "anvil.example/work-state-run-id": "run_1",
                    "anvil.example/run-current": "{\"id\":\"run_1\",\"state\":\"running\",\"started_at\":\"2026-01-01T10:00:00Z\"}"
                }
            },
            "status": {"phase": "Ready", "serviceFQDN": "anvil-demo-12345678"}
        }))
        .unwrap();
        let sandbox = ReportSandbox {
            object: Arc::new(Mutex::new(object)),
        };
        let mut config = config("http://profile.test".into());
        config.session_signing_secret = Some("x".repeat(32));
        let token = github::CapabilitySigner::new("x".repeat(32), Duration::from_secs(60))
            .unwrap()
            .mint("demo-12345678", "https://github.com/example/demo.git")
            .unwrap();
        let app = router(AppState::new(config, sandbox));

        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/sessions/demo-12345678/report-context")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await["run_id"], "run_1");

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/report")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"run_id":"run_1","disposition":"ready_for_review","summary":"  validated  "}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json_response(response).await["work_state"],
            "ready_for_review"
        );

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/complete")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await["work_state"], "completed");

        let response = app
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/report")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"run_id":"run_1","disposition":"awaiting_input"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn github_credential_endpoint_separates_capability_and_upstream_failures() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/app/installations/42/access_tokens")
                .json_body(json!({
                    "repositories": ["demo"],
                    "permissions": github::GithubCredentialPurpose::Legacy.permissions()
                }));
            then.status(201).json_body(json!({
                "token": "ghs_legacy",
                "expires_at": "2099-01-01T00:00:00Z"
            }));
        });
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/app/installations/42/access_tokens")
                .json_body(json!({
                    "repositories": ["demo"],
                    "permissions": github::GithubCredentialPurpose::Git.permissions()
                }));
            then.status(422)
                .header("x-github-request-id", "safe-request-id")
                .json_body(json!({
                    "message": "requested permissions are not available",
                    "documentation_url": "https://docs.github.com/safe"
                }));
        });
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "agents.x-k8s.io/v1beta1",
            "kind": "Sandbox",
            "metadata": {
                "name": "anvil-demo-12345678",
                "annotations": {
                    "anvil.example/project": "demo",
                    "anvil.example/repository": "https://github.com/acme/demo.git",
                    "anvil.example/base-ref": "main",
                    "anvil.example/work-branch": "anvil/demo-12345678"
                }
            },
            "status": {"phase": "Ready"}
        }))
        .unwrap();
        let sandbox = ReportSandbox {
            object: Arc::new(Mutex::new(object)),
        };
        let mut test_config = config(server.base_url());
        test_config.session_signing_secret = Some("x".repeat(32));
        let signer =
            github::CapabilitySigner::new("x".repeat(32), Duration::from_secs(60)).unwrap();
        let valid_token = signer
            .mint("demo-12345678", "https://github.com/acme/demo.git")
            .unwrap();
        let mismatch_token = signer
            .mint("demo-12345678", "https://github.com/acme/other.git")
            .unwrap();
        let mut state = AppState::new(test_config, sandbox);
        state.github = Some(
            github::GithubBroker::new(github::GithubConfig {
                app_id: "1".into(),
                installation_id: 42,
                private_key: "not-used-in-test".into(),
                api_url: Url::parse(&server.base_url()).unwrap(),
            })
            .with_jwt("test-jwt"),
        );
        let app = router(state);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/credentials/github")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/credentials/github")
                    .header("authorization", format!("Bearer {mismatch_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/credentials/github")
                    .header("authorization", format!("Bearer {valid_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let legacy = json_response(response).await;
        assert_eq!(legacy["permissions"]["contents"], "write");
        assert_eq!(legacy["permissions"].as_object().unwrap().len(), 7);

        let response = app
            .oneshot(
                Request::post("/v1/sessions/demo-12345678/credentials/github")
                    .header("authorization", format!("Bearer {valid_token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"purpose":"git"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = json_response(response).await;
        assert_eq!(body["error"]["code"], "github_token_scope_rejected");
        assert_eq!(body["error"]["upstream_status"], 422);
        assert_eq!(body["error"]["github_request_id"], "safe-request-id");
        assert_eq!(
            body["error"]["documentation_url"],
            "https://docs.github.com/safe"
        );
    }

    #[test]
    fn activity_preserves_prompts_and_completed_duration() {
        let session = activity_session();
        let activity = build_activity(
            &session,
            "Ready",
            Some("Running"),
            json!([
                {
                    "info": {"id":"msg_1","role":"user","time":{"created":1767261600000i64}},
                    "parts": [{"type":"text","text":"Make the mobile layout\nwithout changing the API."}]
                },
                {
                    "info": {
                        "id":"msg_2","role":"assistant","parentID":"msg_1",
                        "providerID":"openai","modelID":"gpt-5.6-luna",
                        "time":{"created":1767261601000i64,"completed":1767261606000i64}
                    },
                    "parts": []
                }
            ]),
            json!({"ses_demo":{"type":"idle"}}),
            &config("http://profile.test".into()),
        );

        assert_eq!(activity.state, "idle");
        assert_eq!(activity.requests.len(), 1);
        assert_eq!(
            activity.requests[0].prompt,
            "Make the mobile layout\nwithout changing the API."
        );
        assert_eq!(activity.requests[0].state, "completed");
        assert_eq!(activity.requests[0].duration_ms, Some(6_000));
        assert_eq!(activity.requests[0].provider.as_deref(), Some("openai"));
        assert!(activity
            .lifecycle
            .iter()
            .any(|event| event.kind == "request_completed"));
    }

    #[test]
    fn activity_represents_an_unfinished_request_as_active() {
        let session = activity_session();
        let activity = build_activity(
            &session,
            "Ready",
            Some("Running"),
            json!([{
                "info": {"id":"msg_1","role":"user","time":{"created":1767261600000i64}},
                "parts": [{"type":"text","text":"Run the test suite."}]
            }]),
            json!({"ses_demo":{"type":"busy"}}),
            &config("http://profile.test".into()),
        );

        assert_eq!(activity.state, "active");
        assert_eq!(activity.request_state, "running");
        assert_eq!(activity.requests[0].duration_ms, None);
        assert_eq!(activity.requests[0].prompt, "Run the test suite.");
    }

    #[test]
    fn ready_condition_is_authoritative_when_sandbox_has_no_phase() {
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "agents.x-k8s.io/v1beta1",
            "kind": "Sandbox",
            "metadata": {
                "name": "anvil-demo-12345678",
                "annotations": {
                    "anvil.example/project": "demo",
                    "anvil.example/repository": "https://github.com/example/demo.git",
                    "anvil.example/base-ref": "main",
                    "anvil.example/work-branch": "anvil/demo-12345678"
                }
            },
            "status": {
                "conditions": [{"type":"Ready","status":"True"}],
                "serviceFQDN": "anvil-demo-12345678"
            }
        }))
        .unwrap();
        let session = session_from(&object, &config("http://profile.test".into())).unwrap();
        assert_eq!(session.environment_state, "ready");
        assert_eq!(session.phase.as_deref(), Some("Ready"));
    }

    #[test]
    fn sandbox_environment_distinguishes_provisioning_suspended_and_failure() {
        let base: DynamicObject = serde_json::from_value(json!({
            "metadata": {"name": "anvil-demo-12345678"},
            "status": {"conditions": [{"type":"Ready","status":"False","reason":"DependenciesNotReady"}]}
        }))
        .unwrap();
        assert_eq!(sandbox_environment(&base, false).0, "provisioning");
        assert_eq!(sandbox_environment(&base, true).0, "suspended");
        let failed: DynamicObject = serde_json::from_value(json!({
            "metadata": {"name": "anvil-demo-12345678"},
            "status": {"conditions": [{"type":"Ready","status":"False","reason":"SandboxFailed"}]}
        }))
        .unwrap();
        assert_eq!(sandbox_environment(&failed, false).0, "failed");
    }

    #[test]
    fn run_annotations_are_json_encoded_strings() {
        let run = Run {
            id: "run_test".into(),
            state: "running".into(),
            started_at: "2026-01-01T10:00:00Z".into(),
            finished_at: None,
        };
        let value = run_value(Some(&run));
        let encoded = value.as_str().expect("annotation value must be a string");
        assert_eq!(serde_json::from_str::<Run>(encoded).unwrap(), run);
        assert!(run_value(None).is_null());

        let annotations = work_state_annotations(
            &config("http://profile.test".into()),
            &WorkStateRecord {
                state: WorkState::InProgress,
                changed_at: run.started_at.clone(),
                summary: None,
                run_id: Some(run.id.clone()),
                current_run: Some(run.clone()),
                last_run: None,
            },
        );
        assert!(annotations
            .values()
            .all(|value| value.is_string() || value.is_null()));
        assert_eq!(
            annotations
                .get("anvil.example/run-current")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Run>(value).ok()),
            Some(run)
        );
    }

    #[tokio::test]
    async fn forwards_the_resolved_model_to_async_prompts() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/config/providers");
            then.status(200).json_body(json!({
                "providers": [{
                    "id": "openai",
                    "name": "OpenAI",
                    "models": {
                        "gpt-5.6-luna": {
                            "id": "gpt-5.6-luna",
                            "providerID": "openai"
                        }
                    }
                }]
            }));
        });
        let prompt = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/session/session-1/prompt_async")
                .json_body(json!({
                    "model": {
                        "providerID": "openai",
                        "modelID": "gpt-5.6-luna"
                    },
                    "parts": [{"type": "text", "text": "Inspect the repository."}]
                }));
            then.status(204);
        });

        let oc = OpenCode::new(server.base_url(), Duration::from_secs(5));
        let model = oc.resolve_model("gpt-5.6-luna").await.unwrap();
        assert_eq!(model.qualified_id(), "openai/gpt-5.6-luna");
        oc.prompt_async("session-1", "Inspect the repository.", Some(&model))
            .await
            .unwrap();
        prompt.assert_async().await;
    }

    #[tokio::test]
    async fn rejects_unavailable_explicit_models() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/config/providers");
            then.status(200).json_body(json!({"providers": []}));
        });

        let oc = OpenCode::new(server.base_url(), Duration::from_secs(5));
        let error = oc.resolve_model("gpt-5.6-luna").await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "OpenCode error: requested model is unavailable: gpt-5.6-luna"
        );
    }

    #[tokio::test]
    async fn treats_a_missing_opencode_session_as_recoverable_binding_loss() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/session/ses_missing");
            then.status(404)
                .json_body(json!({"name":"NotFoundError","message":"Session not found"}));
        });
        let op = OpenCode::new(server.base_url(), Duration::from_secs(5));
        assert!(!op.session_exists("ses_missing").await.unwrap());
    }

    #[tokio::test]
    async fn automatically_replaces_a_missing_binding_once_and_records_continuity_loss() {
        let server = MockServer::start();
        let server_url = Url::parse(&server.base_url()).unwrap();
        let missing = server.mock(|when, then| {
            when.method(GET).path("/session/ses_old");
            then.status(404)
                .json_body(json!({"name":"NotFoundError","message":"Session not found"}));
        });
        let replacement = server.mock(|when, then| {
            when.method(httpmock::Method::POST).path("/session");
            then.status(200).json_body(json!({"id":"ses_new"}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/session/ses_new");
            then.status(200).json_body(json!({"id":"ses_new"}));
        });
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "agents.x-k8s.io/v1beta1",
            "kind": "Sandbox",
            "metadata": {
                "name": "anvil-demo-12345678",
                "annotations": {
                    "anvil.example/project": "demo",
                    "anvil.example/repository": "https://github.com/example/demo.git",
                    "anvil.example/base-ref": "main",
                    "anvil.example/work-branch": "anvil/demo-12345678",
                    "anvil.example/created-at": "2026-01-01T10:00:00Z",
                    "anvil.example/model": "openai/gpt-5.6-luna",
                    "anvil.example/opencode-session-id": "ses_old",
                    "anvil.example/binding-state": "available",
                    "anvil.example/binding-continuity": "exact"
                }
            },
            "status": {
                "phase": "Ready",
                "serviceFQDN": "127.0.0.1"
            }
        }))
        .unwrap();
        let object = Arc::new(Mutex::new(object));
        let mut test_config = config(format!("{}/", server.base_url()));
        test_config.opencode_port = server_url.port().unwrap();
        let state = AppState::new(
            test_config,
            BindingSandbox {
                object: object.clone(),
            },
        );

        let (first, second) = tokio::join!(
            reconcile_binding(&state, "demo-12345678"),
            reconcile_binding(&state, "demo-12345678")
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.opencode_session_id.as_deref(), Some("ses_new"));
        assert_eq!(second.opencode_session_id.as_deref(), Some("ses_new"));
        assert_eq!(first.session_binding_state, "rebound");
        assert_eq!(first.session_binding_continuity, "lost");
        missing.assert_hits(1);
        replacement.assert_hits(1);
        let annotations = object.lock().unwrap().annotations().clone();
        assert_eq!(
            annotations.get("anvil.example/opencode-session-id"),
            Some(&"ses_new".to_owned())
        );
        assert_eq!(
            annotations.get("anvil.example/binding-previous-session-id"),
            Some(&"ses_old".to_owned())
        );
    }

    async fn json_response(response: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn lists_normalized_provider_state_without_credentials() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/provider");
            then.status(200).json_body(json!({
                "all": [{"id":"openai","name":"OpenAI"}],
                "connected": ["openai"]
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/provider/auth");
            then.status(200).json_body(json!({
                "openai": [{"type":"oauth","label":"ChatGPT OAuth"}]
            }));
        });
        let app = router(AppState::new(config(server.base_url()), FakeSandbox));
        let response = app
            .oneshot(Request::get("/v1/providers").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["providers"][0]["id"], "openai");
        assert_eq!(body["providers"][0]["authenticated"], true);
        assert!(body["providers"][0].get("credentials").is_none());
    }

    #[tokio::test]
    async fn begins_and_completes_oauth_through_profile_server() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/provider");
            then.status(200).json_body(json!({
                "all": [{"id":"openai","name":"OpenAI"}],
                "connected": []
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/provider/auth");
            then.status(200).json_body(json!({
                "openai": [{"type":"oauth","label":"ChatGPT OAuth"}]
            }));
        });
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/provider/openai/oauth/authorize")
                .json_body(json!({"method":0,"inputs":{}}));
            then.status(200).json_body(json!({
                "url":"https://auth.openai.com/authorize",
                "method":"code",
                "instructions":"Open the URL.",
                "user_code":"ABCD-EFGH"
            }));
        });
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/provider/openai/oauth/callback")
                .json_body(json!({"method":0,"code":"ABCD-EFGH"}));
            then.status(200).json_body(true);
        });
        let app = router(AppState::new(config(server.base_url()), FakeSandbox));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/providers/openai/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"method":"oauth"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let flow = json_response(response).await;
        assert_eq!(flow["state"], "awaiting_user");
        assert_eq!(flow["user_code"], "ABCD-EFGH");
        let login_id = flow["login_id"].as_str().unwrap();
        let response = app
            .oneshot(
                Request::post(format!("/v1/providers/openai/login/{login_id}/complete"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"code":"ABCD-EFGH"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await["authenticated"], true);
    }

    #[tokio::test]
    async fn begins_and_completes_api_key_login_without_logging_key() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/provider");
            then.status(200).json_body(json!({
                "all": [{"id":"opencode-go","name":"OpenCode Go","env":["OPENCODE_API_KEY"]}],
                "connected": []
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/provider/auth");
            then.status(200).json_body(json!({}));
        });
        let auth_set = server.mock(|when, then| {
            when.method(httpmock::Method::PUT)
                .path("/auth/opencode-go")
                .json_body(json!({"type":"api","key":"secret-go-key"}));
            then.status(200).json_body(true);
        });
        let app = router(AppState::new(config(server.base_url()), FakeSandbox));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/providers/opencode-go/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"method":"api"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let flow = json_response(response).await;
        assert_eq!(flow["method"], "api_key");
        let login_id = flow["login_id"].as_str().unwrap();
        let response = app
            .oneshot(
                Request::post(format!(
                    "/v1/providers/opencode-go/login/{login_id}/complete"
                ))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"key":"secret-go-key"}"#))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await["authenticated"], true);
        auth_set.assert_async().await;
    }

    #[tokio::test]
    async fn rejects_unknown_login_ids_without_upstream_calls() {
        let server = MockServer::start();
        let app = router(AppState::new(config(server.base_url()), FakeSandbox));
        let response = app
            .oneshot(
                Request::post("/v1/providers/openai/login/not-a-real-login/complete")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"code":"not-a-secret"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn redacts_sensitive_global_config_values() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/config");
            then.status(200).json_body(json!({
                "theme":"dark",
                "provider":{"openai":{"api_key":"do-not-return"}},
                "nested":[{"access_token":"also-do-not-return"}]
            }));
        });
        let app = router(AppState::new(config(server.base_url()), FakeSandbox));
        let response = app
            .oneshot(
                Request::get("/v1/opencode/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["theme"], "dark");
        assert_eq!(body["provider"]["openai"]["api_key"], "[redacted]");
        assert_eq!(body["nested"][0]["access_token"], "[redacted]");
    }
}
