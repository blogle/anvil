//! HTTP control plane for Anvil Kubernetes sandboxes.

use anvil_core::{
    branch_name, preview_hostname, GitRef, LoginFlow, Port, Project, Prompt, ProviderAuthMethod,
    ProviderListResponse, ProviderStatus, ProviderSummary, Repository, Session, SessionId,
};
use async_trait::async_trait;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use kube::{
    api::{
        Api, ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
    },
    Client, ResourceExt,
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    sync::{Arc, Mutex},
    time::Duration,
};
use thiserror::Error;
use tracing::{info, warn};

const MANAGED: &str = "app.kubernetes.io/managed-by";
const APP: &str = "app.kubernetes.io/name";
const LOGIN_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_port: u16,
    pub namespace: String,
    pub image: String,
    pub workspace_size: String,
    pub opencode_port: u16,
    pub request_timeout: Duration,
    pub secret_name: Option<String>,
    pub preview_domain: String,
    pub annotation_prefix: String,
    pub profile_opencode_url: String,
    pub profile_pvc: String,
}
impl Config {
    pub fn from_env() -> Result<Self, ServiceError> {
        let get = |k: &str, d: &str| {
            env::var(k)
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| d.into())
        };
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
            secret_name: env::var("ANVIL_OPENCODE_ENV_SECRET")
                .ok()
                .filter(|v| !v.is_empty()),
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
    #[error("invalid request: {0}")]
    Invalid(String),
}
impl IntoResponse for ServiceError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            ServiceError::NotFound => StatusCode::NOT_FOUND,
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
}
#[derive(Debug, Deserialize)]
pub struct PromptRequest {
    pub prompt: String,
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
}

#[derive(Debug, Clone)]
struct PendingLogin {
    provider: String,
    method: usize,
    created_at: std::time::Instant,
}

#[derive(Debug, Deserialize)]
struct OpenCodeProvider {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct OpenCodeProviderList {
    #[serde(default)]
    all: Vec<OpenCodeProvider>,
    #[serde(default)]
    connected: Vec<String>,
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
    async fn create(&self, id: &str, request: &CreateRequest) -> Result<Session, ServiceError>;
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
        phase: o
            .data
            .get("status")
            .and_then(|v| v.get("phase"))
            .and_then(Value::as_str)
            .map(String::from),
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
    async fn create(&self, id: &str, r: &CreateRequest) -> Result<Session, ServiceError> {
        let ns = &self.config.namespace;
        let name = format!("anvil-{id}");
        let now = chrono_like_now();
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
            Value::String(now),
        );
        if let Some(model) = &r.model {
            annotations.insert(
                annotation_key(&self.config, "model"),
                Value::String(model.clone()),
            );
        }
        // The prompt is deliberately not represented in this object (nor in logs).
        let mut container = json!({"name":"sandbox","image":self.config.image,"ports":[{"name":"opencode","containerPort":self.config.opencode_port}],"env":[{"name":"ANVIL_PROJECT","value":r.project},{"name":"ANVIL_REPOSITORY","value":r.repository},{"name":"ANVIL_REF","value":r.base_ref},{"name":"ANVIL_WORK_BRANCH","value":work_branch},{"name":"OPENCODE_CONFIG","value":"/anvil/profile/config/opencode.jsonc"},{"name":"OPENCODE_CONFIG_DIR","value":"/anvil/profile/config"}],"volumeMounts":[{"name":"workspace","mountPath":"/workspace"},{"name":"shared-profile","mountPath":"/anvil/profile"}]});
        if let Some(secret) = &self.config.secret_name {
            container["envFrom"] = json!([{"secretRef":{"name":secret}}]);
        }
        let obj = json!({"apiVersion":"agents.x-k8s.io/v1beta1","kind":"Sandbox","metadata":{"name":name,"namespace":ns,"labels":l,"annotations":annotations},"spec":{"service":true,"podTemplate":{"spec":{"containers":[container],"volumes":[{"name":"shared-profile","persistentVolumeClaim":{"claimName":self.config.profile_pvc}}]}},"volumeClaimTemplates":[{"metadata":{"name":"workspace"},"spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":self.config.workspace_size}}}}]}});
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
    format!(
        "{}Z",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    )
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub kube: Arc<dyn SandboxApi>,
    profile: ProfileClient,
    pending_logins: Arc<Mutex<HashMap<String, PendingLogin>>>,
}
impl AppState {
    pub fn new<K: SandboxApi>(config: Config, kube: K) -> Self {
        let profile = ProfileClient::new(&config.profile_opencode_url)
            .expect("ANVIL_PROFILE_OPENCODE_URL must be a valid URL");
        Self {
            config,
            kube: Arc::new(kube),
            profile,
            pending_logins: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/v1/sessions", post(create).get(enumerate))
        .route("/v1/sessions/:id", get(session).delete(remove))
        .route("/v1/sessions/:id/messages", post(prompt).get(messages))
        .route("/v1/sessions/:id/status", get(status))
        .route("/v1/sessions/:id/diff", get(diff))
        .route("/v1/sessions/:id/abort", post(abort))
        .route("/v1/sessions/:id/suspend", post(suspend))
        .route("/v1/sessions/:id/resume", post(resume))
        .route("/v1/sessions/:id/previews/:port", get(preview))
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
    let id = SessionId::new(&p).to_string();
    let mut sess = s.kube.create(&id, &r).await?;
    let mut obj = wait_ready(&s, &id).await?;
    sess = session_from(&obj, &s.config).unwrap_or(sess);
    let oc = OpenCode::new(service_url(&sess, &s.config), s.config.request_timeout);
    wait_opencode(&oc, s.config.request_timeout).await?;
    let oc_id = oc.create_session().await?;
    s.kube.set_opencode_session(&id, &oc_id).await?;
    oc.prompt_async(&oc_id, prompt.as_str()).await?;
    obj = s.kube.get(&id).await?;
    Ok((
        StatusCode::CREATED,
        Json(session_from(&obj, &s.config).unwrap_or_else(|_| {
            sess.opencode_session_id = Some(oc_id);
            sess
        })),
    ))
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
async fn enumerate(State(s): State<AppState>) -> Result<Json<Vec<Session>>, ServiceError> {
    Ok(Json(
        s.kube
            .list()
            .await?
            .iter()
            .filter_map(|o| session_from(o, &s.config).ok())
            .collect(),
    ))
}
async fn session(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<Session>, ServiceError> {
    Ok(Json(session_from(&s.kube.get(&id).await?, &s.config)?))
}
async fn suspend(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<StatusCode, ServiceError> {
    s.kube.suspend(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn resume(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<StatusCode, ServiceError> {
    s.kube.resume(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn remove(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<StatusCode, ServiceError> {
    s.kube.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn prompt(
    Path(id): Path<String>,
    State(s): State<AppState>,
    Json(r): Json<PromptRequest>,
) -> Result<Json<Value>, ServiceError> {
    let p = Prompt::new(&r.prompt).map_err(|e| ServiceError::Invalid(e.to_string()))?;
    let x = session_from(&s.kube.get(&id).await?, &s.config)?;
    Ok(Json(
        OpenCode::new(service_url(&x, &s.config), s.config.request_timeout)
            .prompt_async(
                x.opencode_session_id
                    .as_deref()
                    .ok_or(ServiceError::NotFound)?,
                p.as_str(),
            )
            .await?,
    ))
}
async fn proxy(
    Path(id): Path<String>,
    State(s): State<AppState>,
    op: &str,
    method: reqwest::Method,
    query: Option<&str>,
) -> Result<Json<Value>, ServiceError> {
    let x = session_from(&s.kube.get(&id).await?, &s.config)?;
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
    let x = session_from(&s.kube.get(&id).await?, &s.config)?;
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
    Ok(Json(selected))
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
    let method = selected.unwrap_or_else(|| {
        methods
            .iter()
            .position(|method| method.kind == "oauth")
            .unwrap_or(usize::MAX)
    });
    let selected_method = methods.get(method).ok_or_else(|| {
        ServiceError::Invalid(format!(
            "provider {provider} has no OAuth authentication method"
        ))
    })?;
    if selected_method.kind != "oauth" {
        return Err(ServiceError::Invalid(format!(
            "provider {provider} authentication method is not OAuth"
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
            method,
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
    let completed: bool = serde_json::from_value(
        s.profile
            .request(
                reqwest::Method::POST,
                &format!("provider/{provider}/oauth/callback"),
                Some(json!({"method": pending.method, "code": request.code})),
            )
            .await?,
    )
    .map_err(|e| ServiceError::Profile(e.to_string()))?;
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
    async fn prompt_async(&self, id: &str, p: &str) -> Result<Value, ServiceError> {
        self.request(
            &format!("session/{id}/prompt_async"),
            reqwest::Method::POST,
            Some(json!({"parts":[{"type":"text","text":p}]})),
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
            return Err(ServiceError::OpenCode(v.to_string()));
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use httpmock::{Method::GET, MockServer};
    use tower::ServiceExt;

    struct FakeSandbox;

    #[async_trait]
    impl SandboxApi for FakeSandbox {
        async fn list(&self) -> Result<Vec<DynamicObject>, ServiceError> {
            Ok(Vec::new())
        }
        async fn create(
            &self,
            _id: &str,
            _request: &CreateRequest,
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

    fn config(profile_opencode_url: String) -> Config {
        Config {
            bind_port: 8080,
            namespace: "anvil".into(),
            image: "sandbox:dev".into(),
            workspace_size: "1Gi".into(),
            opencode_port: 4096,
            request_timeout: Duration::from_secs(5),
            secret_name: None,
            preview_domain: "preview.example.test".into(),
            annotation_prefix: "anvil.example".into(),
            profile_opencode_url,
            profile_pvc: "anvil-opencode-profile".into(),
        }
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
