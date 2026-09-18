//! HTTP control plane for Anvil Kubernetes sandboxes.

mod github;

use anvil_core::{
    branch_name, preview_hostname, GitRef, LifecycleEvent, LoginFlow, Port, Project, Prompt,
    ProviderAuthMethod, ProviderListResponse, ProviderStatus, ProviderSummary, Repository, Session,
    SessionActivity, SessionId, SessionRequest,
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
    #[error("invalid request: {0}")]
    Invalid(String),
}
impl IntoResponse for ServiceError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            ServiceError::NotFound => StatusCode::NOT_FOUND,
            ServiceError::Unauthorized => StatusCode::UNAUTHORIZED,
            ServiceError::Forbidden(_) => StatusCode::FORBIDDEN,
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
        if let Some(model) = &r.model {
            annotations.insert(
                annotation_key(&self.config, "model"),
                Value::String(model.clone()),
            );
        }
        // The prompt is deliberately not represented in this object (nor in logs).
        let mut env = vec![
            json!({"name":"ANVIL_PROJECT","value":r.project}),
            json!({"name":"ANVIL_REPOSITORY","value":r.repository}),
            json!({"name":"ANVIL_REF","value":r.base_ref}),
            json!({"name":"ANVIL_WORK_BRANCH","value":work_branch}),
            json!({"name":"OPENCODE_CONFIG","value":"/anvil/profile/config/opencode.jsonc"}),
            json!({"name":"OPENCODE_CONFIG_DIR","value":"/anvil/profile/config"}),
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
        let container = json!({"name":"sandbox","image":self.config.image,"ports":[{"name":"opencode","containerPort":self.config.opencode_port}],"env":env,"volumeMounts":[{"name":"workspace","mountPath":"/workspace"},{"name":"shared-profile","mountPath":"/anvil/profile"}]});
        let obj = json!({"apiVersion":"agents.x-k8s.io/v1beta1","kind":"Sandbox","metadata":{"name":name,"namespace":ns,"labels":l,"annotations":annotations},"spec":{"service":true,"podTemplate":{"spec":{"securityContext":{"runAsUser":1000,"runAsGroup":1000,"fsGroup":1000},"containers":[container],"volumes":[{"name":"shared-profile","persistentVolumeClaim":{"claimName":self.config.profile_pvc}}]}},"volumeClaimTemplates":[{"metadata":{"name":"workspace"},"spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":self.config.workspace_size}}}}]}});
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
            created_at: Some(now),
            ready_at: None,
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

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub kube: Arc<dyn SandboxApi>,
    profile: ProfileClient,
    pending_logins: Arc<Mutex<HashMap<String, PendingLogin>>>,
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
            config,
            kube: Arc::new(kube),
            profile,
            pending_logins: Arc::new(Mutex::new(HashMap::new())),
            capability_signer,
            github,
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
        .route("/v1/sessions/:id/activity", get(activity))
        .route(
            "/v1/sessions/:id/credentials/github",
            post(github_credentials),
        )
        .route("/assets/app.js", get(asset_js))
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
    let mut obj = wait_ready(&s, &id).await?;
    let ready_at = chrono_like_now();
    s.kube.set_ready_at(&id, &ready_at).await?;
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
    oc.prompt_async(&oc_id, prompt.as_str(), model.as_ref())
        .await?;
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
        .credential(&session.repository)
        .await
        .map(Json)
        .map_err(ServiceError::Config)
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

async fn activity(
    Path(id): Path<String>,
    State(s): State<AppState>,
) -> Result<Json<SessionActivity>, ServiceError> {
    let object = s.kube.get(&id).await?;
    let session = session_from(&object, &s.config)?;
    let phase = session.phase.as_deref().unwrap_or("Starting");
    let operating_mode = object
        .data
        .get("spec")
        .and_then(|value| value.get("operatingMode"))
        .and_then(Value::as_str);
    let messages = if let Some(opencode_id) = session.opencode_session_id.as_deref() {
        let op = OpenCode::new(service_url(&session, &s.config), s.config.request_timeout);
        let messages_path = format!("session/{opencode_id}/message");
        let (messages, status) = tokio::join!(
            op.request(&messages_path, reqwest::Method::GET, None),
            op.request("session/status", reqwest::Method::GET, None),
        );
        let messages = messages.unwrap_or_else(|_| Value::Array(Vec::new()));
        let status = status.unwrap_or(Value::Null);
        build_activity(&session, phase, operating_mode, messages, status, &s.config)
    } else {
        build_activity(
            &session,
            phase,
            operating_mode,
            Value::Array(Vec::new()),
            Value::Null,
            &s.config,
        )
    };
    Ok(Json(messages))
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
    let oc = OpenCode::new(service_url(&x, &s.config), s.config.request_timeout);
    let model = match x.model.as_deref() {
        Some(requested) => Some(oc.resolve_model(requested).await?),
        None => None,
    };
    Ok(Json(
        oc.prompt_async(
            x.opencode_session_id
                .as_deref()
                .ok_or(ServiceError::NotFound)?,
            p.as_str(),
            model.as_ref(),
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

fn build_activity(
    session: &Session,
    phase: &str,
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
    } else if phase.eq_ignore_ascii_case("failed") {
        "failed"
    } else if !phase.eq_ignore_ascii_case("ready") || session.opencode_session_id.is_none() {
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
    }
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

    struct ActivitySandbox {
        object: DynamicObject,
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
        assert_eq!(
            body["attach_command"],
            "anvilctl sessions attach demo-12345678"
        );
        assert_eq!(body["lifecycle"][0]["kind"], "created");

        let response = app
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
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
