//! Stateless Streamable HTTP MCP facade for Anvil's semantic HTTP API.

use axum::{routing::get, Router};
use reqwest::{Client, Method, Url};
use rmcp::{
    handler::server::{
        router::tool::ToolRouter,
        wrapper::{Json, Parameters},
    },
    model::{ServerCapabilities, ServerConfig},
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, ServerHandler,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::env;

#[derive(Debug, Deserialize, JsonSchema)]
struct Create {
    project: String,
    repository: String,
    #[serde(rename = "ref")]
    reference: String,
    prompt: String,
    model: Option<String>,
    author_name: Option<String>,
    author_email: Option<String>,
    idempotency_key: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct Session {
    session_id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct MutationSession {
    session_id: String,
    idempotency_key: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct MutationMessage {
    session_id: String,
    prompt: String,
    idempotency_key: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct MutationRecovery {
    session_id: String,
    prompt: Option<String>,
    idempotency_key: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct Preview {
    session_id: String,
    port: u16,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct BatchTask {
    task_id: String,
    prompt: String,
    #[serde(default)]
    dependencies: Vec<String>,
    owner: Option<String>,
    policy: Option<Value>,
    pr_policy: Option<Value>,
    evidence_contract: Option<Value>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct BatchSubmission {
    project: String,
    repository: String,
    #[serde(rename = "ref")]
    reference: String,
    concurrency: usize,
    #[serde(default)]
    allow_competing_tasks: bool,
    policies: Option<Value>,
    tasks: Vec<BatchTask>,
    idempotency_key: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct ResourceId {
    id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct TaskResourceId {
    task_id: String,
    idempotency_key: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct BatchDigestRequest {
    batch_id: String,
    after: Option<String>,
    #[serde(default)]
    attention_only: bool,
    view: Option<String>,
}

#[derive(Clone)]
struct AnvilMcp {
    client: Client,
    base: Url,
    #[allow(dead_code)] // Read by rmcp's generated tool dispatcher.
    tool_router: ToolRouter<Self>,
}

impl AnvilMcp {
    fn new(base: Url) -> Result<Self, ErrorData> {
        Ok(Self {
            client: Client::builder()
                .use_rustls_tls()
                .build()
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?,
            base,
            tool_router: Self::tool_router(),
        })
    }
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ErrorData> {
        self.call_with_key(method, path, body, None).await
    }

    async fn call_with_key(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ErrorData> {
        let url = self
            .base
            .join(path)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut request = self.client.request(method, url);
        if let Some(key) = idempotency_key.filter(|key| !key.trim().is_empty()) {
            request = request.header("Idempotency-Key", key);
        }
        let response = if let Some(value) = body {
            request.json(&value)
        } else {
            request
        }
        .send()
        .await
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        if !status.is_success() {
            let detail = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(
                |_| json!({"message": String::from_utf8_lossy(&bytes).into_owned()}),
            );
            return Err(api_error(status, detail));
        }
        Ok(if bytes.is_empty() {
            json!({"accepted": true, "session_id": session_id_from_path(path)})
        } else {
            serde_json::from_slice(&bytes).map_err(|e| {
                ErrorData::internal_error(
                    format!("Anvil returned invalid JSON: {e}"),
                    Some(json!({"http_status": status.as_u16()})),
                )
            })?
        })
    }

    async fn mutation(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ErrorData> {
        let result = self
            .call_with_key(method.clone(), path, body, idempotency_key)
            .await?;
        let session_id = session_id_from_path(path);
        if method == Method::DELETE {
            return Ok(json!({
                "accepted": true,
                "operation": "delete",
                "session_id": session_id,
                "result": result,
            }));
        }
        let status = self
            .call(
                Method::GET,
                &format!("v1/sessions/{session_id}/status"),
                None,
            )
            .await?;
        Ok(json!({
            "accepted": true,
            "session_id": session_id,
            "result": result,
            "status": status,
        }))
    }
}

fn session_id_from_path(path: &str) -> String {
    path.strip_prefix("v1/sessions/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default()
        .to_owned()
}

fn api_error(status: reqwest::StatusCode, detail: Value) -> ErrorData {
    let data = Some(json!({"http_status":status.as_u16(),"error":detail}));
    if status == reqwest::StatusCode::CONFLICT {
        ErrorData::new(
            rmcp::model::ErrorCode::INVALID_PARAMS,
            format!("Anvil idempotency conflict (HTTP {status})"),
            data,
        )
    } else {
        ErrorData::internal_error(format!("Anvil API returned {status}"), data)
    }
}

#[cfg(test)]
const CONTROLLER_OPERATIONS: &[&str] = &[
    "anvil_submit_batch",
    "anvil_get_batch",
    "anvil_get_task",
    "anvil_get_attempt",
    "anvil_create_attempt",
    "anvil_get_batch_digest",
    "anvil_list_sessions",
    "anvil_get_session",
    "anvil_get_activity",
    "anvil_get_status",
    "anvil_create_session",
    "anvil_send_message",
    "anvil_get_messages",
    "anvil_get_diff",
    "anvil_get_preview",
    "anvil_suspend",
    "anvil_resume",
    "anvil_abort",
    "anvil_delete_session",
    "anvil_rebind_session",
];

#[rmcp::tool_router]
impl AnvilMcp {
    #[rmcp::tool(
        description = "Read a compact digest of a durable batch. Defaults to the compact agent view; after accepts the opaque GET /v1/changes cursor, and attention_only filters rows without changing cursor progression."
    )]
    async fn anvil_get_batch_digest(
        &self,
        Parameters(p): Parameters<BatchDigestRequest>,
    ) -> Result<Json<Value>, ErrorData> {
        let mut url = self
            .base
            .join(&format!("v1/batches/{}/digest", p.batch_id))
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        {
            let mut query = url.query_pairs_mut();
            if let Some(after) = p.after.as_deref() {
                query.append_pair("after", after);
            }
            if p.attention_only {
                query.append_pair("attention_only", "true");
            }
            if let Some(view) = p.view.as_deref() {
                query.append_pair("view", view);
            }
        }
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if !status.is_success() {
            let detail = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(
                |_| json!({"message":String::from_utf8_lossy(&bytes).into_owned()}),
            );
            return Err(ErrorData::internal_error(
                format!("Anvil API returned {status}"),
                Some(json!({"http_status":status.as_u16(),"error":detail})),
            ));
        }
        let digest = serde_json::from_slice(&bytes)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(Json(digest))
    }

    #[rmcp::tool(
        description = "Create an isolated OpenCode development session from a public Git repository."
    )]
    async fn anvil_create_session(
        &self,
        Parameters(p): Parameters<Create>,
    ) -> Result<Json<Value>, ErrorData> {
        let session = self
            .call_with_key(
                Method::POST,
                "v1/sessions",
                Some(json!({"project":p.project,"repository":p.repository,"ref":p.reference,"prompt":p.prompt,"model":p.model,"author_name":p.author_name,"author_email":p.author_email})),
                p.idempotency_key.as_deref(),
            )
            .await?;
        Ok(Json(
            json!({"accepted":true,"session_id":session.get("id").and_then(Value::as_str),"session":session}),
        ))
    }
    #[rmcp::tool(
        description = "Atomically accept a durable batch plan and its logical tasks. Task execution is queued for later provisioning."
    )]
    async fn anvil_submit_batch(
        &self,
        Parameters(p): Parameters<BatchSubmission>,
    ) -> Result<Json<Value>, ErrorData> {
        let tasks: Vec<_> = p.tasks.into_iter().map(|task| json!({"task_id":task.task_id,"prompt":task.prompt,"dependencies":task.dependencies,"owner":task.owner,"policy":task.policy.unwrap_or(Value::Null),"pr_policy":task.pr_policy.unwrap_or(Value::Null),"evidence_contract":task.evidence_contract.unwrap_or(Value::Null)})).collect();
        let url = self
            .base
            .join("v1/batches")
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let mut request = self.client.post(url);
        if let Some(key) = p
            .idempotency_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
        {
            request = request.header("Idempotency-Key", key);
        }
        let response = request.json(&json!({"project":p.project,"repository":p.repository,"ref":p.reference,"concurrency":p.concurrency,"allow_competing_tasks":p.allow_competing_tasks,"policies":p.policies.unwrap_or(Value::Null),"tasks":tasks})).send().await.map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if !status.is_success() {
            return Err(api_error(status, body));
        }
        Ok(Json(body))
    }
    #[rmcp::tool(description = "Get an accepted durable batch by ID.")]
    async fn anvil_get_batch(
        &self,
        Parameters(p): Parameters<ResourceId>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(Method::GET, &format!("v1/batches/{}", p.id), None)
                .await?,
        ))
    }
    #[rmcp::tool(description = "Get an accepted logical task by ID.")]
    async fn anvil_get_task(
        &self,
        Parameters(p): Parameters<ResourceId>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(Method::GET, &format!("v1/tasks/{}", p.id), None)
                .await?,
        ))
    }
    #[rmcp::tool(description = "Get a durable execution attempt by ID.")]
    async fn anvil_get_attempt(
        &self,
        Parameters(p): Parameters<ResourceId>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(Method::GET, &format!("v1/attempts/{}", p.id), None)
                .await?,
        ))
    }
    #[rmcp::tool(
        description = "Create a replacement execution attempt for an existing logical task."
    )]
    async fn anvil_create_attempt(
        &self,
        Parameters(p): Parameters<TaskResourceId>,
    ) -> Result<Json<Value>, ErrorData> {
        let url = self
            .base
            .join(&format!("v1/tasks/{}/attempts", p.task_id))
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let mut request = self.client.post(url);
        if let Some(key) = p
            .idempotency_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
        {
            request = request.header("Idempotency-Key", key);
        }
        let response = request
            .json(&json!({}))
            .send()
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if !status.is_success() {
            return Err(api_error(status, body));
        }
        Ok(Json(body))
    }
    #[rmcp::tool(description = "List available Anvil development sessions.")]
    async fn anvil_list_sessions(&self) -> Result<Json<Value>, ErrorData> {
        Ok(Json(self.call(Method::GET, "v1/sessions", None).await?))
    }
    #[rmcp::tool(description = "Get details for an Anvil development session.")]
    async fn anvil_get_session(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(Method::GET, &format!("v1/sessions/{}", p.session_id), None)
                .await?,
        ))
    }
    #[rmcp::tool(
        description = "Get the complete normalized activity read model for a session, including requests, lifecycle, state axes, and recovery details."
    )]
    async fn anvil_get_activity(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(
                Method::GET,
                &format!("v1/sessions/{}/activity", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Send a message to the OpenCode conversation in a development session."
    )]
    async fn anvil_send_message(
        &self,
        Parameters(p): Parameters<MutationMessage>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/messages", p.session_id),
                Some(json!({"prompt":p.prompt})),
                p.idempotency_key.as_deref(),
            )
            .await?,
        ))
    }
    #[rmcp::tool(description = "Retrieve the OpenCode conversation messages for a session.")]
    async fn anvil_get_messages(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(
                Method::GET,
                &format!("v1/sessions/{}/messages", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Get environment/runtime, OpenCode execution, run history, and conversation-binding status for a session."
    )]
    async fn anvil_get_status(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(
                Method::GET,
                &format!("v1/sessions/{}/status", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(description = "Get the repository diff produced in a session.")]
    async fn anvil_get_diff(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(
                Method::GET,
                &format!("v1/sessions/{}/diff", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(description = "Get the browser preview URL for a port in a session.")]
    async fn anvil_get_preview(
        &self,
        Parameters(p): Parameters<Preview>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.call(
                Method::GET,
                &format!("v1/sessions/{}/previews/{}", p.session_id, p.port),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(description = "Stop the current OpenCode task in a session.")]
    async fn anvil_abort(
        &self,
        Parameters(p): Parameters<MutationSession>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/abort", p.session_id),
                None,
                p.idempotency_key.as_deref(),
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Suspend a development session while preserving its workspace and conversation."
    )]
    async fn anvil_suspend(
        &self,
        Parameters(p): Parameters<MutationSession>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/suspend", p.session_id),
                None,
                p.idempotency_key.as_deref(),
            )
            .await?,
        ))
    }
    #[rmcp::tool(description = "Resume a previously suspended development session.")]
    async fn anvil_resume(
        &self,
        Parameters(p): Parameters<MutationSession>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/resume", p.session_id),
                None,
                p.idempotency_key.as_deref(),
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Operator escape hatch: explicitly create a replacement OpenCode session. Normal session recovery is automatic; this loses conversation continuity and records that fact."
    )]
    async fn anvil_rebind_session(
        &self,
        Parameters(p): Parameters<MutationRecovery>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/rebind", p.session_id),
                Some(json!({"prompt":p.prompt})),
                p.idempotency_key.as_deref(),
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Permanently delete an Anvil development session and its workspace."
    )]
    async fn anvil_delete_session(
        &self,
        Parameters(p): Parameters<MutationSession>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::DELETE,
                &format!("v1/sessions/{}", p.session_id),
                None,
                p.idempotency_key.as_deref(),
            )
            .await?,
        ))
    }
}

#[rmcp::tool_handler]
impl ServerHandler for AnvilMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Use Anvil to work in isolated persistent OpenCode development sessions.",
        )
    }
}

fn allowed_hosts() -> Vec<String> {
    env::var("MCP_ALLOWED_HOSTS")
        .ok()
        .map(|hosts| {
            hosts
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .filter(|hosts: &Vec<String>| !hosts.is_empty())
        .unwrap_or_else(|| vec!["localhost".into(), "127.0.0.1".into()])
}

fn app(base: Url) -> Router {
    let server = AnvilMcp::new(base).expect("Anvil MCP server should initialize");
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(allowed_hosts())
            .with_legacy_session_mode(false)
            .with_json_response(true),
    );
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest_service("/mcp", service)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().init();
    let base =
        Url::parse(&env::var("ANVIL_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/".into()))?;
    let app = app(base);
    axum::serve(tokio::net::TcpListener::bind("0.0.0.0:8081").await?, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        AnvilMcp, BatchDigestRequest, BatchSubmission, BatchTask, MutationRecovery, ResourceId,
        TaskResourceId, CONTROLLER_OPERATIONS,
    };
    use httpmock::{Method::GET, MockServer};
    use rmcp::handler::server::wrapper::Parameters;
    use serde_json::json;

    #[tokio::test]
    async fn batch_tool_forwards_idempotency_key_and_returns_authoritative_plan() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/batches")
                .header("idempotency-key", "batch-key");
            then.status(201)
                .json_body(json!({"batch_id":"batch-1","base_commit":"a"}));
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        let response = mcp
            .anvil_submit_batch(Parameters(BatchSubmission {
                project: "demo".into(),
                repository: "https://github.com/example/demo".into(),
                reference: "main".into(),
                concurrency: 1,
                allow_competing_tasks: false,
                policies: None,
                tasks: vec![BatchTask {
                    task_id: "task-1".into(),
                    prompt: "do work".into(),
                    dependencies: vec![],
                    owner: None,
                    policy: None,
                    pr_policy: None,
                    evidence_contract: None,
                }],
                idempotency_key: Some("batch-key".into()),
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(response["batch_id"], "batch-1");
        assert_eq!(response["base_commit"], "a");
        let replay = mcp
            .anvil_submit_batch(Parameters(BatchSubmission {
                project: "demo".into(),
                repository: "https://github.com/example/demo".into(),
                reference: "main".into(),
                concurrency: 1,
                allow_competing_tasks: false,
                policies: None,
                tasks: vec![BatchTask {
                    task_id: "task-1".into(),
                    prompt: "do work".into(),
                    dependencies: vec![],
                    owner: None,
                    policy: None,
                    pr_policy: None,
                    evidence_contract: None,
                }],
                idempotency_key: Some("batch-key".into()),
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(replay, response);
    }

    #[tokio::test]
    async fn batch_tool_surfaces_http_idempotency_conflicts() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(httpmock::Method::POST).path("/v1/batches");
            then.status(409)
                .json_body(json!({"error":{"message":"different batch plan"}}));
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        let result = mcp
            .anvil_submit_batch(Parameters(BatchSubmission {
                project: "demo".into(),
                repository: "https://github.com/example/demo".into(),
                reference: "main".into(),
                concurrency: 1,
                allow_competing_tasks: false,
                policies: None,
                tasks: vec![],
                idempotency_key: Some("key".into()),
            }))
            .await;
        let Err(error) = result else {
            panic!("HTTP conflict must become an MCP tool error")
        };
        assert!(error.message.contains("409"));
        assert_eq!(error.code, rmcp::model::ErrorCode::INVALID_PARAMS);
        assert_eq!(error.data.unwrap()["http_status"], 409);
    }

    #[tokio::test]
    async fn resource_tools_get_batch_task_attempt_and_create_replacement_attempt() {
        let server = MockServer::start_async().await;
        for (path, body) in [
            ("/v1/batches/batch-1", json!({"batch_id":"batch-1"})),
            ("/v1/tasks/task-1", json!({"task_id":"task-1"})),
            ("/v1/attempts/attempt-1", json!({"attempt_id":"attempt-1"})),
        ] {
            server.mock(move |when, then| {
                when.method(GET).path(path);
                then.status(200).json_body(body.clone());
            });
        }
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/tasks/task-1/attempts")
                .header("idempotency-key", "attempt-key");
            then.status(201)
                .json_body(json!({"attempt_id":"attempt-2","ordinal":2}));
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        assert_eq!(
            mcp.anvil_get_batch(Parameters(ResourceId {
                id: "batch-1".into()
            }))
            .await
            .unwrap()
            .0["batch_id"],
            "batch-1"
        );
        assert_eq!(
            mcp.anvil_get_task(Parameters(ResourceId {
                id: "task-1".into()
            }))
            .await
            .unwrap()
            .0["task_id"],
            "task-1"
        );
        assert_eq!(
            mcp.anvil_get_attempt(Parameters(ResourceId {
                id: "attempt-1".into()
            }))
            .await
            .unwrap()
            .0["attempt_id"],
            "attempt-1"
        );
        assert_eq!(
            mcp.anvil_create_attempt(Parameters(TaskResourceId {
                task_id: "task-1".into(),
                idempotency_key: Some("attempt-key".into())
            }))
            .await
            .unwrap()
            .0["ordinal"],
            2
        );
    }

    #[tokio::test]
    async fn batch_digest_tool_forwards_opaque_cursor_and_view_to_live_route() {
        let server = MockServer::start_async().await;
        let response = json!({
            "schema_version":1,
            "batch_id":"batch-1",
            "cursor":"anv1.42",
            "counts":{"total":1,"queued":0,"active":1,"review":0,"failed":0,"done":0},
            "tasks":[{"id":"task-1","state":"running","attempt_id":"attempt-1"}]
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/v1/batches/batch-1/digest")
                .query_param("after", "opaque.cursor+/=")
                .query_param("attention_only", "true")
                .query_param("view", "human");
            then.status(200).json_body(response.clone());
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/batches/batch-1/digest");
            then.status(200).json_body(response.clone());
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        let digest = mcp
            .anvil_get_batch_digest(Parameters(BatchDigestRequest {
                batch_id: "batch-1".into(),
                after: Some("opaque.cursor+/=".into()),
                attention_only: true,
                view: Some("human".into()),
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(digest["batch_id"], "batch-1");
        assert_eq!(digest["tasks"][0]["attempt_id"], "attempt-1");
        let agent_default = mcp
            .anvil_get_batch_digest(Parameters(BatchDigestRequest {
                batch_id: "batch-1".into(),
                after: None,
                attention_only: false,
                view: None,
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(agent_default["tasks"][0]["id"], "task-1");
        assert!(agent_default.get("text").is_none());
    }

    #[test]
    fn controller_surface_includes_required_operations() {
        for operation in [
            "anvil_submit_batch",
            "anvil_get_batch_digest",
            "anvil_list_sessions",
            "anvil_get_session",
            "anvil_get_activity",
            "anvil_get_status",
            "anvil_create_session",
            "anvil_create_attempt",
            "anvil_send_message",
            "anvil_suspend",
            "anvil_resume",
            "anvil_abort",
            "anvil_delete_session",
            "anvil_rebind_session",
            "anvil_get_messages",
            "anvil_get_diff",
            "anvil_get_preview",
        ] {
            assert!(
                CONTROLLER_OPERATIONS.contains(&operation),
                "missing {operation}"
            );
        }
    }

    #[tokio::test]
    async fn streamable_http_tools_list_exposes_complete_controller_surface() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let app = super::app(reqwest::Url::parse("http://127.0.0.1:8080/").unwrap());
        let initialize = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "127.0.0.1")
            .header("mcp-protocol-version", "2025-06-18")
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "anvil-mcp-test", "version": "0.1.0"}
                    }
                })
                .to_string(),
            ))
            .unwrap();
        let response = app.clone().oneshot(initialize).await.unwrap();
        assert!(response.status().is_success());

        let tools_list = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "127.0.0.1")
            .header("mcp-protocol-version", "2025-06-18")
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}).to_string(),
            ))
            .unwrap();
        let response = app.oneshot(tools_list).await.unwrap();
        assert!(response.status().is_success());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let tools = payload["result"]["tools"]
            .as_array()
            .expect("tools/list must return a tool array");
        let names: std::collections::HashSet<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(!names.contains("anvil_complete_session"));
        for operation in CONTROLLER_OPERATIONS {
            assert!(
                names.contains(operation),
                "transport is missing {operation}"
            );
        }
        for mutation in [
            "anvil_create_session",
            "anvil_submit_batch",
            "anvil_create_attempt",
            "anvil_send_message",
            "anvil_abort",
            "anvil_suspend",
            "anvil_resume",
            "anvil_rebind_session",
            "anvil_delete_session",
        ] {
            let tool = tools.iter().find(|tool| tool["name"] == mutation).unwrap();
            assert!(
                tool["inputSchema"]["properties"]
                    .get("idempotency_key")
                    .is_some(),
                "{mutation} schema lacks idempotency_key"
            );
        }
        for readonly in [
            "anvil_get_session",
            "anvil_get_messages",
            "anvil_get_status",
            "anvil_get_diff",
            "anvil_get_batch",
            "anvil_get_task",
            "anvil_get_attempt",
        ] {
            let tool = tools.iter().find(|tool| tool["name"] == readonly).unwrap();
            assert!(
                tool["inputSchema"]["properties"]
                    .get("idempotency_key")
                    .is_none(),
                "{readonly} should remain read-only"
            );
        }
    }

    #[tokio::test]
    async fn rebind_returns_structured_acceptance_and_status() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/sessions/demo-12345678/rebind");
            then.status(200).json_body(json!({
                "id": "demo-12345678",
                "session_binding_state": "rebound",
                "session_binding_continuity": "lost",
                "opencode_session_id": "ses_new"
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/sessions/demo-12345678/status");
            then.status(200).json_body(json!({
                "environment_state": "ready",
                "execution_state": "idle",
            }));
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        let result = mcp
            .anvil_rebind_session(Parameters(MutationRecovery {
                session_id: "demo-12345678".into(),
                prompt: None,
                idempotency_key: None,
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(result["accepted"], true);
        assert_eq!(result["session_id"], "demo-12345678");
        assert_eq!(result["result"]["session_binding_continuity"], "lost");
        assert_eq!(result["status"]["environment_state"], "ready");
        assert_eq!(result["status"]["execution_state"], "idle");
        assert!(result["status"].get("work_state").is_none());
    }

    #[tokio::test]
    async fn mutation_forwards_key_and_conflict_is_structured() {
        let server = MockServer::start_async().await;
        let accepted = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/sessions/demo/messages")
                .header("Idempotency-Key", "retry-42")
                .json_body(json!({"prompt":"hello"}));
            then.status(200).json_body(json!({"message":"original"}));
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        let result = mcp
            .call_with_key(
                reqwest::Method::POST,
                "v1/sessions/demo/messages",
                Some(json!({"prompt":"hello"})),
                Some("retry-42"),
            )
            .await
            .unwrap();
        assert_eq!(result["message"], "original");
        accepted.assert();

        let conflict = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/sessions/demo/messages")
                .header("Idempotency-Key", "retry-42")
                .json_body(json!({"prompt":"changed"}));
            then.status(409)
                .json_body(json!({"error":{"message":"Idempotency-Key conflict"}}));
        });
        let error = mcp
            .call_with_key(
                reqwest::Method::POST,
                "v1/sessions/demo/messages",
                Some(json!({"prompt":"changed"})),
                Some("retry-42"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, rmcp::model::ErrorCode::INVALID_PARAMS);
        assert!(error.message.contains("idempotency conflict"));
        assert_eq!(error.data.as_ref().unwrap()["http_status"], 409);
        conflict.assert();
    }
}
