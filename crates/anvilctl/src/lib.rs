use anvil_core::{LoginFlow, ProviderListResponse, ProviderStatus, Session};
use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{self, Write},
    net::TcpListener,
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time::sleep};

#[derive(Debug, Parser)]
#[command(name = "anvilctl", about = "Operate a deployed Anvil installation")]
pub struct Cli {
    /// Anvil HTTP API base URL.
    #[arg(long, env = "ANVIL_URL", default_value = "http://127.0.0.1:8080/")]
    pub server: String,
    /// Emit JSON where supported.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: CommandGroup,
}

#[derive(Debug, Subcommand)]
pub enum CommandGroup {
    Providers(ProvidersCommand),
    Sessions(SessionsCommand),
}

#[derive(Debug, Args)]
pub struct ProvidersCommand {
    #[command(subcommand)]
    pub command: ProvidersSubcommand,
}

#[derive(Debug, Subcommand)]
pub enum ProvidersSubcommand {
    List,
    Login {
        provider: String,
        #[arg(long)]
        method: Option<String>,
    },
}

#[derive(Debug, Args)]
#[command(name = "sessions", alias = "session")]
pub struct SessionsCommand {
    #[command(subcommand)]
    pub command: SessionsSubcommand,
}

#[derive(Debug, Subcommand)]
pub enum SessionsSubcommand {
    List,
    Get { session: String },
    Create(CreateArgs),
    Status { session: String },
    Suspend { session: String },
    Resume { session: String },
    Delete { session: String },
    Preview { session: String, port: u16 },
    Attach { session: String },
    Complete { session: String },
    Rebind(RebindArgs),
}

#[derive(Debug, Args, Serialize)]
pub struct RebindArgs {
    pub session: String,
    #[arg(long)]
    pub prompt: Option<String>,
}

#[derive(Debug, Args, Serialize)]
pub struct CreateArgs {
    #[arg(long)]
    pub project: String,
    #[arg(long)]
    pub repository: String,
    #[arg(long = "ref", default_value = "main")]
    #[serde(rename = "ref")]
    pub reference: String,
    #[arg(long)]
    pub prompt: String,
    #[arg(long)]
    pub model: Option<String>,
    /// Git author name to carry into the Sandbox session.
    #[arg(long, env = "ANVIL_GIT_AUTHOR_NAME")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    /// Git author email to carry into the Sandbox session.
    #[arg(long, env = "ANVIL_GIT_AUTHOR_EMAIL")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_email: Option<String>,
}

#[derive(Clone)]
pub struct ApiClient {
    client: Client,
    base: Url,
}

impl ApiClient {
    pub fn new(server: &str) -> Result<Self> {
        let mut base = Url::parse(server).context("invalid Anvil server URL")?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            client: Client::new(),
            base,
        })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let url = self.base.join(path).context("invalid Anvil API path")?;
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("request to Anvil failed")?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .context("reading Anvil response failed")?;
        if !status.is_success() {
            let detail = String::from_utf8_lossy(&bytes);
            return Err(anyhow!("Anvil returned {status}: {detail}"));
        }
        if bytes.is_empty() || status == StatusCode::NO_CONTENT {
            return serde_json::from_value(Value::Null).context("unexpected empty Anvil response");
        }
        serde_json::from_slice(&bytes).context("invalid JSON response from Anvil")
    }

    async fn no_content(&self, method: Method, path: &str) -> Result<()> {
        let _: Value = self.request(method, path, None).await?;
        Ok(())
    }

    async fn providers(&self) -> Result<ProviderListResponse> {
        self.request(Method::GET, "v1/providers", None).await
    }

    async fn begin_login(
        &self,
        provider: &str,
        method: &str,
        inputs: HashMap<String, String>,
    ) -> Result<LoginFlow> {
        self.request(
            Method::POST,
            &format!("v1/providers/{provider}/login"),
            Some(serde_json::json!({"method":method,"inputs":inputs})),
        )
        .await
    }

    async fn complete_login(
        &self,
        flow: &LoginFlow,
        code: Option<String>,
        key: Option<String>,
    ) -> Result<ProviderStatus> {
        self.request(
            Method::POST,
            &format!(
                "v1/providers/{}/login/{}/complete",
                flow.provider, flow.login_id
            ),
            Some(serde_json::json!({"code":code,"key":key})),
        )
        .await
    }
}

pub async fn run(cli: Cli) -> Result<()> {
    let client = ApiClient::new(&cli.server)?;
    match cli.command {
        CommandGroup::Providers(args) => match args.command {
            ProvidersSubcommand::List => {
                let result = client.providers().await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("{:<12} {:<15}", "PROVIDER", "STATUS");
                    for provider in result.providers {
                        println!(
                            "{:<12} {}",
                            provider.id,
                            if provider.authenticated {
                                "authenticated"
                            } else {
                                "not authenticated"
                            }
                        );
                    }
                }
            }
            ProvidersSubcommand::Login { provider, method } => {
                let available = client.providers().await?;
                let provider_info = available
                    .providers
                    .iter()
                    .find(|candidate| candidate.id == provider)
                    .with_context(|| format!("unknown provider: {provider}"))?;
                let requested = method.as_deref();
                let selected = requested.and_then(|requested| {
                    requested.parse::<usize>().ok().or_else(|| {
                        provider_info.auth_methods.iter().position(|candidate| {
                            candidate.label.eq_ignore_ascii_case(requested)
                                || candidate.kind.eq_ignore_ascii_case(requested)
                                || (requested.eq_ignore_ascii_case("api-key")
                                    && candidate.kind.eq_ignore_ascii_case("api_key"))
                        })
                    })
                });
                let method_index = selected
                    .or_else(|| {
                        provider_info.auth_methods.iter().position(|candidate| {
                            candidate.kind == "oauth"
                                && candidate.label.to_ascii_lowercase().contains("headless")
                        })
                    })
                    .or_else(|| {
                        provider_info
                            .auth_methods
                            .iter()
                            .position(|candidate| candidate.kind == "oauth")
                    });
                let use_api_key = requested.is_some_and(|requested| {
                    requested.eq_ignore_ascii_case("api")
                        || requested.eq_ignore_ascii_case("api-key")
                        || requested.eq_ignore_ascii_case("api_key")
                }) || method_index
                    .and_then(|index| provider_info.auth_methods.get(index))
                    .is_some_and(|candidate| {
                        candidate.kind == "api" || candidate.kind == "api_key"
                    })
                    || (requested.is_none() && method_index.is_none());
                if use_api_key && !provider_info.api_key_available {
                    return Err(anyhow!(
                        "provider {provider} does not advertise API-key authentication"
                    ));
                }
                let method_name = if use_api_key {
                    "api".to_owned()
                } else {
                    method_index
                        .with_context(|| {
                            format!("provider {provider} has no supported authentication method")
                        })?
                        .to_string()
                };
                let inputs = if use_api_key {
                    HashMap::new()
                } else {
                    let selected_method = method_index
                        .and_then(|index| provider_info.auth_methods.get(index))
                        .with_context(|| {
                            format!("invalid authentication method for provider {provider}")
                        })?;
                    if selected_method.kind != "oauth" {
                        return Err(anyhow!(
                            "provider authentication method is not OAuth or API key"
                        ));
                    }
                    collect_prompt_inputs(selected_method.prompts.as_ref())?
                };
                let flow = client.begin_login(&provider, &method_name, inputs).await?;
                if flow.method == "api_key" {
                    println!("{} API key", provider_name(&provider));
                    let key = rpassword::prompt_password("Enter API key: ")?;
                    println!("\nSubmitting API key...");
                    let result = client.complete_login(&flow, None, Some(key)).await?;
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else if result.authenticated {
                        println!("Authenticated successfully.");
                    } else {
                        return Err(anyhow!("provider authentication did not complete"));
                    }
                } else {
                    println!("{} OAuth", provider_name(&provider));
                    if let Some(url) = &flow.verification_url {
                        println!("\nOpen this URL in your browser:\n\n{url}");
                    }
                    if let Some(code) = &flow.user_code {
                        println!("\nEnter code:\n\n{code}");
                    }
                    if let Some(instructions) = &flow.instructions {
                        println!("\n{instructions}");
                    }
                    let code = if flow.method == "code" {
                        print!("\nEnter authorization code: ");
                        io::stdout().flush()?;
                        let mut input = String::new();
                        io::stdin().read_line(&mut input)?;
                        Some(input.trim().to_owned())
                    } else {
                        None
                    };
                    println!("\nWaiting for authorization...");
                    let result = client.complete_login(&flow, code, None).await?;
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else if result.authenticated {
                        println!("Authenticated successfully.");
                    } else {
                        return Err(anyhow!("provider authentication did not complete"));
                    }
                }
            }
        },
        CommandGroup::Sessions(args) => run_sessions(client, args.command, cli.json).await?,
    }
    Ok(())
}

fn collect_prompt_inputs(prompts: Option<&Vec<Value>>) -> Result<HashMap<String, String>> {
    let mut inputs = HashMap::new();
    for prompt in prompts.into_iter().flatten() {
        let Some(kind) = prompt.get("type").and_then(Value::as_str) else {
            continue;
        };
        let key = prompt.get("key").and_then(Value::as_str).unwrap_or("");
        if key.is_empty() || !prompt_applies(prompt, &inputs) {
            continue;
        }
        let message = prompt.get("message").and_then(Value::as_str).unwrap_or(key);
        let options = prompt
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if kind == "select" {
            for (index, option) in options.iter().enumerate() {
                println!(
                    "  {}. {}",
                    index + 1,
                    option.get("label").and_then(Value::as_str).unwrap_or("")
                );
            }
            print!("{message}: ");
        } else {
            print!("{message}: ");
        }
        io::stdout().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        let input = input.trim().to_owned();
        if kind == "select" {
            if let Ok(index) = input.parse::<usize>() {
                if let Some(value) = options
                    .get(index.saturating_sub(1))
                    .and_then(|item| item.get("value"))
                    .and_then(Value::as_str)
                {
                    inputs.insert(key.to_owned(), value.to_owned());
                    continue;
                }
            }
        }
        inputs.insert(key.to_owned(), input);
    }
    Ok(inputs)
}

fn prompt_applies(prompt: &Value, inputs: &HashMap<String, String>) -> bool {
    let Some(when) = prompt.get("when") else {
        return true;
    };
    let key = when.get("key").and_then(Value::as_str).unwrap_or("");
    let expected = when.get("value").and_then(Value::as_str).unwrap_or("");
    let actual = inputs.get(key).map(String::as_str).unwrap_or("");
    match when.get("op").and_then(Value::as_str) {
        Some("neq") => actual != expected,
        _ => actual == expected,
    }
}

fn provider_name(id: &str) -> String {
    match id {
        "openai" => "OpenAI / ChatGPT".into(),
        _ => id.to_owned(),
    }
}

async fn run_sessions(client: ApiClient, command: SessionsSubcommand, json: bool) -> Result<()> {
    match command {
        SessionsSubcommand::List => list_sessions(&client, json).await,
        SessionsSubcommand::Get { session } => {
            print_response(
                &client,
                Method::GET,
                &format!("v1/sessions/{session}"),
                None,
                json,
            )
            .await
        }
        SessionsSubcommand::Create(args) => {
            anvil_core::Project::new(&args.project).map_err(|e| anyhow!(e.to_string()))?;
            anvil_core::Repository::new(&args.repository).map_err(|e| anyhow!(e.to_string()))?;
            anvil_core::GitRef::new(&args.reference).map_err(|e| anyhow!(e.to_string()))?;
            anvil_core::Prompt::new(&args.prompt).map_err(|e| anyhow!(e.to_string()))?;
            let body = serde_json::to_value(&args)?;
            print_response(&client, Method::POST, "v1/sessions", Some(body), json).await
        }
        SessionsSubcommand::Status { session } => {
            print_response(
                &client,
                Method::GET,
                &format!("v1/sessions/{session}/status"),
                None,
                json,
            )
            .await
        }
        SessionsSubcommand::Suspend { session } => {
            client
                .no_content(Method::POST, &format!("v1/sessions/{session}/suspend"))
                .await
        }
        SessionsSubcommand::Resume { session } => {
            print_response(
                &client,
                Method::POST,
                &format!("v1/sessions/{session}/resume"),
                None,
                json,
            )
            .await
        }
        SessionsSubcommand::Delete { session } => {
            client
                .no_content(Method::DELETE, &format!("v1/sessions/{session}"))
                .await
        }
        SessionsSubcommand::Preview { session, port } => {
            print_response(
                &client,
                Method::GET,
                &format!("v1/sessions/{session}/previews/{port}"),
                None,
                json,
            )
            .await
        }
        SessionsSubcommand::Attach { session } => attach(client, &session).await,
        SessionsSubcommand::Complete { session } => {
            print_response(
                &client,
                Method::POST,
                &format!("v1/sessions/{session}/complete"),
                None,
                json,
            )
            .await
        }
        SessionsSubcommand::Rebind(args) => {
            print_response(
                &client,
                Method::POST,
                &format!("v1/sessions/{}/rebind", args.session),
                Some(serde_json::to_value(args)?),
                json,
            )
            .await
        }
    }
}

async fn list_sessions(client: &ApiClient, json: bool) -> Result<()> {
    let sessions: Vec<Session> = client.request(Method::GET, "v1/sessions", None).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
    } else {
        println!("{:<24} {:<16} {:<18}", "SESSION", "PROJECT", "WORK STATE");
        for session in sessions {
            println!(
                "{:<24} {:<16} {}",
                session.id,
                session.project,
                if session.work_state.is_empty() {
                    "unknown"
                } else {
                    &session.work_state
                }
            );
        }
    }
    Ok(())
}

fn print_value<T: Serialize>(value: T, json: bool) {
    if json {
        println!("{}", serde_json::to_string_pretty(&value).unwrap());
    } else if let Ok(value) = serde_json::to_value(value) {
        println!("{}", serde_json::to_string_pretty(&value).unwrap());
    }
}

async fn print_response(
    client: &ApiClient,
    method: Method,
    path: &str,
    body: Option<Value>,
    json: bool,
) -> Result<()> {
    let value: Value = client.request(method, path, body).await?;
    print_value(value, json);
    Ok(())
}

async fn attach(client: ApiClient, session: &str) -> Result<()> {
    let metadata: Session = client
        .request(Method::GET, &format!("v1/sessions/{session}"), None)
        .await?;
    let opencode_session = metadata
        .opencode_session_id
        .context("session has no OpenCode session ID")?;
    let local_port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let target = format!("service/{}", metadata.sandbox);
    let mut port_forward = Command::new("kubectl")
        .args([
            "port-forward",
            "-n",
            &metadata.namespace,
            &target,
            &format!("{local_port}:{}", metadata.opencode_port),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("kubectl is required for sessions attach")?;
    let address = format!("http://127.0.0.1:{local_port}");
    let mut ready = false;
    for _ in 0..40 {
        if tokio::net::TcpStream::connect(("127.0.0.1", local_port))
            .await
            .is_ok()
        {
            ready = true;
            break;
        }
        sleep(Duration::from_millis(250)).await;
    }
    if !ready {
        let _ = port_forward.kill().await;
        let _ = port_forward.wait().await;
        return Err(anyhow!("kubectl port-forward did not become ready"));
    }
    let status = Command::new("opencode")
        .args(["attach", &address, "--session", &opencode_session])
        .status()
        .await;
    let _ = port_forward.kill().await;
    let _ = port_forward.wait().await;
    let status = status.context("opencode is required for sessions attach")?;
    if !status.success() {
        return Err(anyhow!("opencode attach exited with {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::{Method::GET, MockServer};

    #[tokio::test]
    async fn lists_providers_as_json_contract() {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(GET).path("/v1/providers");
            then.status(200).json_body(serde_json::json!({"providers":[{"id":"openai","name":"OpenAI","authenticated":true,"auth_methods":[]}]}));
        });
        let providers = ApiClient::new(&server.base_url())
            .unwrap()
            .providers()
            .await
            .unwrap();
        mock.assert_async().await;
        assert!(providers.providers[0].authenticated);
    }

    #[tokio::test]
    async fn serializes_session_create_request() {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(httpmock::Method::POST).path("/v1/sessions").json_body(serde_json::json!({"project":"demo","repository":"https://github.com/example/demo.git","ref":"main","prompt":"Inspect","model":null}));
            then.status(201).json_body(serde_json::json!({"id":"demo-12345678","sandbox":"anvil-demo-12345678","service":"","namespace":"anvil","opencode_port":4096,"phase":null,"project":"demo","repository":"https://github.com/example/demo.git","ref":"main","work_branch":"anvil/demo-12345678","model":null,"opencode_session_id":null}));
        });
        let args = CreateArgs {
            project: "demo".into(),
            repository: "https://github.com/example/demo.git".into(),
            reference: "main".into(),
            prompt: "Inspect".into(),
            model: None,
            author_name: None,
            author_email: None,
        };
        let _: Session = ApiClient::new(&server.base_url())
            .unwrap()
            .request(
                Method::POST,
                "v1/sessions",
                Some(serde_json::to_value(args).unwrap()),
            )
            .await
            .unwrap();
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn relays_provider_login_begin_and_complete() {
        let server = MockServer::start_async().await;
        let begin = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/providers/openai/login")
                .json_body(serde_json::json!({"method":"0","inputs":{}}));
            then.status(200).json_body(serde_json::json!({
                "login_id":"login-1",
                "provider":"openai",
                "state":"awaiting_user",
                "verification_url":"https://auth.example.test",
                "method":"code",
                "instructions":"Open the URL."
            }));
        });
        let complete = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/providers/openai/login/login-1/complete")
                .json_body(serde_json::json!({"code":"ABCD","key":null}));
            then.status(200).json_body(serde_json::json!({
                "provider":"openai","authenticated":true
            }));
        });
        let client = ApiClient::new(&server.base_url()).unwrap();
        let flow = client
            .begin_login("openai", "0", HashMap::new())
            .await
            .unwrap();
        let result = client
            .complete_login(&flow, Some("ABCD".into()), None)
            .await
            .unwrap();
        begin.assert_async().await;
        complete.assert_async().await;
        assert!(result.authenticated);
    }
}
