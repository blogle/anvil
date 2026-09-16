//! HTTP control plane for Anvil Kubernetes sandboxes.

use anvil_core::{
    branch_name, preview_hostname, GitRef, Port, Project, Prompt, Repository, SessionId,
};
use async_trait::async_trait;
use axum::{
    extract::{Path, State},
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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, sync::Arc, time::Duration};
use thiserror::Error;
use tracing::warn;

const MANAGED: &str = "app.kubernetes.io/managed-by";
const APP: &str = "app.kubernetes.io/name";
const SESSION_LABEL: &str = "anvil.thejeffer.net/session";
const PROJECT_LABEL: &str = "anvil.thejeffer.net/project";
const A_PROJECT: &str = "anvil.thejeffer.net/project";
const A_REPOSITORY: &str = "anvil.thejeffer.net/repository";
const A_BASE_REF: &str = "anvil.thejeffer.net/base-ref";
const A_WORK_BRANCH: &str = "anvil.thejeffer.net/work-branch";
const A_OC_SESSION: &str = "anvil.thejeffer.net/opencode-session-id";
const A_CREATED: &str = "anvil.thejeffer.net/created-at";

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
            bind_port: get("ANVILD_PORT", "8080")
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
            preview_domain: get("ANVIL_PREVIEW_DOMAIN", "anvil.test"),
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
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            Json(json!({"error":{"code":status.as_u16(),"message":self.to_string()}})),
        )
            .into_response()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub sandbox: String,
    pub service: String,
    pub phase: Option<String>,
    pub project: String,
    pub repository: String,
    #[serde(rename = "ref")]
    pub base_ref: String,
    pub work_branch: String,
    pub model: Option<String>,
    pub opencode_session_id: Option<String>,
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

fn labels(id: &str) -> Value {
    let project = SessionId::parse(id)
        .map(|session| session.project().to_owned())
        .unwrap_or_default();
    json!({MANAGED:"anvil", APP:"sandbox", SESSION_LABEL:id, PROJECT_LABEL:project})
}
fn session_from(o: &DynamicObject) -> Result<Session, ServiceError> {
    let a = o.annotations();
    let id = a
        .get(SESSION_LABEL)
        .or_else(|| a.get("anvil.dev/session"))
        .cloned()
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
        phase: o
            .data
            .get("status")
            .and_then(|v| v.get("phase"))
            .and_then(Value::as_str)
            .map(String::from),
        project: a.get(A_PROJECT).cloned().unwrap_or_default(),
        repository: a.get(A_REPOSITORY).cloned().unwrap_or_default(),
        base_ref: a.get(A_BASE_REF).cloned().unwrap_or_default(),
        work_branch: a.get(A_WORK_BRANCH).cloned().unwrap_or_default(),
        model: a.get("anvil.thejeffer.net/model").cloned(),
        opencode_session_id: a.get(A_OC_SESSION).cloned(),
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
        let l = labels(id);
        let work_branch = branch_name(&SessionId::parse(id).unwrap());
        let annotations = json!({A_PROJECT:&r.project,A_REPOSITORY:&r.repository,A_BASE_REF:&r.base_ref,A_WORK_BRANCH:&work_branch,A_CREATED:now,"anvil.thejeffer.net/model":&r.model});
        // The prompt is deliberately not represented in this object (nor in logs).
        let mut container = json!({"name":"sandbox","image":self.config.image,"ports":[{"name":"opencode","containerPort":self.config.opencode_port}],"env":[{"name":"ANVIL_PROJECT","value":r.project},{"name":"ANVIL_REPOSITORY","value":r.repository},{"name":"ANVIL_REF","value":r.base_ref},{"name":"ANVIL_WORK_BRANCH","value":work_branch}],"volumeMounts":[{"name":"workspace","mountPath":"/workspace"}]});
        if let Some(secret) = &self.config.secret_name {
            container["envFrom"] = json!([{"secretRef":{"name":secret}}]);
        }
        let obj = json!({"apiVersion":"agents.x-k8s.io/v1beta1","kind":"Sandbox","metadata":{"name":name,"namespace":ns,"labels":l,"annotations":annotations},"spec":{"service":true,"podTemplate":{"spec":{"containers":[container]}},"volumeClaimTemplates":[{"metadata":{"name":"workspace"},"spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":self.config.workspace_size}}}}]}});
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
        self.patch(id, json!({"metadata":{"annotations":{A_OC_SESSION:oc}}}))
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
}
impl AppState {
    pub fn new<K: SandboxApi>(config: Config, kube: K) -> Self {
        Self {
            config,
            kube: Arc::new(kube),
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
    sess = session_from(&obj).unwrap_or(sess);
    let oc = OpenCode::new(service_url(&sess, &s.config), s.config.request_timeout);
    oc.health().await?;
    let oc_id = oc.create_session().await?;
    s.kube.set_opencode_session(&id, &oc_id).await?;
    oc.prompt_async(&oc_id, prompt.as_str()).await?;
    obj = s.kube.get(&id).await?;
    Ok((
        StatusCode::CREATED,
        Json(session_from(&obj).unwrap_or_else(|_| {
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
            .filter_map(|o| session_from(o).ok())
            .collect(),
    ))
}
async fn session(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<Session>, ServiceError> {
    Ok(Json(session_from(&s.kube.get(&id).await?)?))
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
    let x = session_from(&s.kube.get(&id).await?)?;
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
) -> Result<Json<Value>, ServiceError> {
    let x = session_from(&s.kube.get(&id).await?)?;
    Ok(Json(
        OpenCode::new(service_url(&x, &s.config), s.config.request_timeout)
            .request(
                &format!(
                    "session/{}/{}",
                    x.opencode_session_id
                        .as_deref()
                        .ok_or(ServiceError::NotFound)?,
                    op
                ),
                method,
                None,
            )
            .await?,
    ))
}
async fn messages(p: Path<String>, s: State<AppState>) -> Result<Json<Value>, ServiceError> {
    proxy(p, s, "message", reqwest::Method::GET).await
}
async fn status(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<Value>, ServiceError> {
    let x = session_from(&s.kube.get(&id).await?)?;
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
async fn diff(p: Path<String>, s: State<AppState>) -> Result<Json<Value>, ServiceError> {
    proxy(p, s, "diff", reqwest::Method::GET).await
}
async fn abort(p: Path<String>, s: State<AppState>) -> Result<Json<Value>, ServiceError> {
    proxy(p, s, "abort", reqwest::Method::POST).await
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
            .map_err(|e| ServiceError::OpenCode(e.to_string()))?;
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
