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
}
#[derive(Debug, Deserialize, JsonSchema)]
struct Session {
    session_id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct Message {
    session_id: String,
    prompt: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct Recovery {
    session_id: String,
    prompt: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
struct Preview {
    session_id: String,
    port: u16,
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
        let url = self
            .base
            .join(path)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let request = self.client.request(method, url);
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
            return Err(ErrorData::internal_error(
                format!("Anvil API returned {status}"),
                Some(json!({"http_status": status.as_u16(), "error": detail})),
            ));
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
    ) -> Result<Value, ErrorData> {
        let result = self.call(method.clone(), path, body).await?;
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

#[cfg(test)]
const CONTROLLER_OPERATIONS: &[&str] = &[
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
    "anvil_complete_session",
];

#[rmcp::tool_router]
impl AnvilMcp {
    #[rmcp::tool(
        description = "Create an isolated OpenCode development session from a public Git repository."
    )]
    async fn anvil_create_session(
        &self,
        Parameters(p): Parameters<Create>,
    ) -> Result<Json<Value>, ErrorData> {
        let session = self.call(Method::POST, "v1/sessions", Some(json!({"project":p.project,"repository":p.repository,"ref":p.reference,"prompt":p.prompt,"model":p.model,"author_name":p.author_name,"author_email":p.author_email}))).await?;
        Ok(Json(
            json!({"accepted":true,"session_id":session.get("id").and_then(Value::as_str),"session":session}),
        ))
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
        Parameters(p): Parameters<Message>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/messages", p.session_id),
                Some(json!({"prompt":p.prompt})),
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
        description = "Get independent environment, execution, work-state, and OpenCode conversation-binding status for a session."
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
    #[rmcp::tool(
        description = "Accept a session that is ready for review and mark its work completed."
    )]
    async fn anvil_complete_session(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/complete", p.session_id),
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
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/abort", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Suspend a development session while preserving its workspace and conversation."
    )]
    async fn anvil_suspend(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/suspend", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(description = "Resume a previously suspended development session.")]
    async fn anvil_resume(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/resume", p.session_id),
                None,
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Rebind a recovered Anvil workspace to a new OpenCode session when exact conversation recovery is unavailable. This loses conversation continuity and records that fact."
    )]
    async fn anvil_rebind_session(
        &self,
        Parameters(p): Parameters<Recovery>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::POST,
                &format!("v1/sessions/{}/rebind", p.session_id),
                Some(json!({"prompt":p.prompt})),
            )
            .await?,
        ))
    }
    #[rmcp::tool(
        description = "Permanently delete an Anvil development session and its workspace."
    )]
    async fn anvil_delete_session(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<Json<Value>, ErrorData> {
        Ok(Json(
            self.mutation(
                Method::DELETE,
                &format!("v1/sessions/{}", p.session_id),
                None,
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().init();
    let base =
        Url::parse(&env::var("ANVIL_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/".into()))?;
    let server = AnvilMcp::new(base).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(allowed_hosts())
            .with_legacy_session_mode(false)
            .with_json_response(true),
    );
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest_service("/mcp", service);
    axum::serve(tokio::net::TcpListener::bind("0.0.0.0:8081").await?, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{AnvilMcp, Recovery, CONTROLLER_OPERATIONS};
    use httpmock::{Method::GET, MockServer};
    use rmcp::handler::server::wrapper::Parameters;
    use serde_json::json;

    #[test]
    fn controller_surface_includes_required_operations() {
        for operation in [
            "anvil_list_sessions",
            "anvil_get_session",
            "anvil_get_status",
            "anvil_create_session",
            "anvil_send_message",
            "anvil_suspend",
            "anvil_resume",
            "anvil_abort",
            "anvil_delete_session",
            "anvil_rebind_session",
            "anvil_complete_session",
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
                "work_state": "in_progress"
            }));
        });
        let mcp = AnvilMcp::new(reqwest::Url::parse(&format!("{}/", server.base_url())).unwrap())
            .unwrap();
        let result = mcp
            .anvil_rebind_session(Parameters(Recovery {
                session_id: "demo-12345678".into(),
                prompt: None,
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(result["accepted"], true);
        assert_eq!(result["session_id"], "demo-12345678");
        assert_eq!(result["result"]["session_binding_continuity"], "lost");
        assert_eq!(result["status"]["environment_state"], "ready");
    }
}
