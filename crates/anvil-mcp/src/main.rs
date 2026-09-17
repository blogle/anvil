//! Stateless Streamable HTTP MCP facade for Anvil's semantic HTTP API.

use axum::{routing::get, Router};
use reqwest::{Client, Method, Url};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
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
    ) -> Result<String, ErrorData> {
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
            return Err(ErrorData::internal_error(
                format!(
                    "Anvil API returned {status}: {}",
                    String::from_utf8_lossy(&bytes)
                ),
                None,
            ));
        }
        Ok(if bytes.is_empty() {
            "{}".into()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        })
    }
}

#[rmcp::tool_router]
impl AnvilMcp {
    #[rmcp::tool(
        description = "Create an isolated OpenCode development session from a public Git repository."
    )]
    async fn anvil_create_session(
        &self,
        Parameters(p): Parameters<Create>,
    ) -> Result<String, ErrorData> {
        self.call(Method::POST, "v1/sessions", Some(json!({"project":p.project,"repository":p.repository,"ref":p.reference,"prompt":p.prompt,"model":p.model}))).await
    }
    #[rmcp::tool(description = "List available Anvil development sessions.")]
    async fn anvil_list_sessions(&self) -> Result<String, ErrorData> {
        self.call(Method::GET, "v1/sessions", None).await
    }
    #[rmcp::tool(description = "Get details for an Anvil development session.")]
    async fn anvil_get_session(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<String, ErrorData> {
        self.call(Method::GET, &format!("v1/sessions/{}", p.session_id), None)
            .await
    }
    #[rmcp::tool(
        description = "Send a message to the OpenCode conversation in a development session."
    )]
    async fn anvil_send_message(
        &self,
        Parameters(p): Parameters<Message>,
    ) -> Result<String, ErrorData> {
        self.call(
            Method::POST,
            &format!("v1/sessions/{}/messages", p.session_id),
            Some(json!({"prompt":p.prompt})),
        )
        .await
    }
    #[rmcp::tool(description = "Retrieve the OpenCode conversation messages for a session.")]
    async fn anvil_get_messages(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<String, ErrorData> {
        self.call(
            Method::GET,
            &format!("v1/sessions/{}/messages", p.session_id),
            None,
        )
        .await
    }
    #[rmcp::tool(description = "Get the current OpenCode execution status for a session.")]
    async fn anvil_get_status(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<String, ErrorData> {
        self.call(
            Method::GET,
            &format!("v1/sessions/{}/status", p.session_id),
            None,
        )
        .await
    }
    #[rmcp::tool(description = "Get the repository diff produced in a session.")]
    async fn anvil_get_diff(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<String, ErrorData> {
        self.call(
            Method::GET,
            &format!("v1/sessions/{}/diff", p.session_id),
            None,
        )
        .await
    }
    #[rmcp::tool(description = "Get the browser preview URL for a port in a session.")]
    async fn anvil_get_preview(
        &self,
        Parameters(p): Parameters<Preview>,
    ) -> Result<String, ErrorData> {
        self.call(
            Method::GET,
            &format!("v1/sessions/{}/previews/{}", p.session_id, p.port),
            None,
        )
        .await
    }
    #[rmcp::tool(description = "Stop the current OpenCode task in a session.")]
    async fn anvil_abort(&self, Parameters(p): Parameters<Session>) -> Result<String, ErrorData> {
        self.call(
            Method::POST,
            &format!("v1/sessions/{}/abort", p.session_id),
            None,
        )
        .await
    }
    #[rmcp::tool(
        description = "Suspend a development session while preserving its workspace and conversation."
    )]
    async fn anvil_suspend(&self, Parameters(p): Parameters<Session>) -> Result<String, ErrorData> {
        self.call(
            Method::POST,
            &format!("v1/sessions/{}/suspend", p.session_id),
            None,
        )
        .await
    }
    #[rmcp::tool(description = "Resume a previously suspended development session.")]
    async fn anvil_resume(&self, Parameters(p): Parameters<Session>) -> Result<String, ErrorData> {
        self.call(
            Method::POST,
            &format!("v1/sessions/{}/resume", p.session_id),
            None,
        )
        .await
    }
    #[rmcp::tool(
        description = "Permanently delete an Anvil development session and its workspace."
    )]
    async fn anvil_delete_session(
        &self,
        Parameters(p): Parameters<Session>,
    ) -> Result<String, ErrorData> {
        self.call(
            Method::DELETE,
            &format!("v1/sessions/{}", p.session_id),
            None,
        )
        .await
    }
}

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
