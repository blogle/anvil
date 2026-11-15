use anvil_core::{LoginFlow, ProviderListResponse, ProviderStatus, Session};
use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
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
    ProviderCredentials(ProviderCredentialsCommand),
    Sessions(SessionsCommand),
}

#[derive(Debug, Args)]
#[command(name = "provider-credentials")]
pub struct ProviderCredentialsCommand {
    #[command(subcommand)]
    pub command: ProviderCredentialsSubcommand,
}

#[derive(Debug, Subcommand)]
pub enum ProviderCredentialsSubcommand {
    List,
    Set {
        provider: String,
    },
    Oauth {
        provider: String,
        method_id: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct OperatorAuthMethods {
    methods: Vec<OperatorAuthMethod>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct OperatorAuthMethod {
    id: String,
    label: String,
    #[serde(default)]
    form: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct OperatorOAuthStart {
    login_id: String,
    mode: String,
    url: Option<String>,
    instructions: Option<String>,
    #[serde(default)]
    time: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct OperatorOAuthStatus {
    status: String,
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ProviderCredentialMetadata {
    pub provider_id: String,
    pub generation: i64,
    pub created_at: String,
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

    async fn provider_credentials(&self, token: &str) -> Result<Vec<ProviderCredentialMetadata>> {
        self.provider_credentials_request(Method::GET, "v1/provider-credentials", token, None)
            .await
    }

    async fn set_provider_credential(
        &self,
        provider: &str,
        key: String,
        token: &str,
    ) -> Result<ProviderCredentialMetadata> {
        let path = format!("v1/provider-credentials/{provider}");
        self.provider_credentials_request(
            Method::PUT,
            &path,
            token,
            Some(serde_json::json!({"key": key})),
        )
        .await
    }

    async fn operator_auth_methods(
        &self,
        provider: &str,
        token: &str,
    ) -> Result<OperatorAuthMethods> {
        self.provider_credentials_request(
            Method::GET,
            &format!("v1/provider-credentials/{provider}/methods"),
            token,
            None,
        )
        .await
    }

    async fn operator_oauth_start(
        &self,
        provider: &str,
        method_id: &str,
        answer: Option<Value>,
        token: &str,
    ) -> Result<OperatorOAuthStart> {
        let mut body = serde_json::json!({"method_id":method_id});
        if let Some(answer) = answer {
            body["answer"] = answer;
        }
        self.provider_credentials_request(
            Method::POST,
            &format!("v1/provider-credentials/{provider}/oauth"),
            token,
            Some(body),
        )
        .await
    }

    async fn operator_oauth_status(
        &self,
        provider: &str,
        login_id: &str,
        token: &str,
    ) -> Result<OperatorOAuthStatus> {
        self.provider_credentials_request(
            Method::GET,
            &format!("v1/provider-credentials/{provider}/oauth/{login_id}"),
            token,
            None,
        )
        .await
    }

    async fn operator_oauth_complete(
        &self,
        provider: &str,
        login_id: &str,
        code: &str,
        token: &str,
    ) -> Result<OperatorOAuthStatus> {
        self.provider_credentials_request(
            Method::POST,
            &format!("v1/provider-credentials/{provider}/oauth/{login_id}/complete"),
            token,
            Some(serde_json::json!({"code":code})),
        )
        .await
    }

    async fn provider_credentials_request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let url = self.base.join(path).context("invalid Anvil API path")?;
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .context("provider credential request failed")?;
        let status = response.status();
        if !status.is_success() {
            // Never include an error body here: the service may reflect sensitive input.
            return Err(anyhow!(
                "provider credential request failed with status {status}"
            ));
        }
        let bytes = response
            .bytes()
            .await
            .context("reading provider credential response failed")?;
        serde_json::from_slice(&bytes).context("invalid provider credential response")
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
                eprintln!(
                    "WARNING: Profile-only login does not configure worker credentials. Use provider-credentials oauth PROVIDER or provider-credentials set PROVIDER for workers."
                );
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
        CommandGroup::ProviderCredentials(args) => {
            let token = std::env::var("ANVIL_PROVIDER_OPERATOR_TOKEN")
                .ok()
                .filter(|token| !token.is_empty())
                .context("ANVIL_PROVIDER_OPERATOR_TOKEN is required")?;
            match args.command {
                ProviderCredentialsSubcommand::List => {
                    let credentials = client.provider_credentials(&token).await?;
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&credentials)?);
                    } else {
                        println!("{:<24} {:<12} CREATED AT", "PROVIDER", "GENERATION");
                        for credential in credentials {
                            println!(
                                "{:<24} {:<12} {}",
                                credential.provider_id,
                                credential.generation,
                                credential.created_at
                            );
                        }
                    }
                }
                ProviderCredentialsSubcommand::Set { provider } => {
                    validate_provider_id(&provider)?;
                    let key = rpassword::prompt_password("Provider key: ")?;
                    let metadata = client
                        .set_provider_credential(&provider, key, &token)
                        .await?;
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&metadata)?);
                    } else {
                        println!(
                            "Stored provider credential: {} generation {} (created {})",
                            metadata.provider_id, metadata.generation, metadata.created_at
                        );
                    }
                }
                ProviderCredentialsSubcommand::Oauth {
                    provider,
                    method_id,
                } => {
                    validate_provider_id(&provider)?;
                    run_operator_oauth(&client, &provider, method_id.as_deref(), &token).await?;
                }
            }
        }
        CommandGroup::Sessions(args) => run_sessions(client, args.command, cli.json).await?,
    }
    Ok(())
}

async fn run_operator_oauth(
    client: &ApiClient,
    provider: &str,
    requested_method: Option<&str>,
    token: &str,
) -> Result<()> {
    let methods = client.operator_auth_methods(provider, token).await?.methods;
    let selected = if let Some(id) = requested_method {
        methods.iter().find(|method| method.id == id)
    } else if provider == "openai" {
        methods
            .iter()
            .find(|method| method.id == "chatgpt-headless")
            .or_else(|| (methods.len() == 1).then(|| &methods[0]))
    } else {
        (methods.len() == 1).then(|| &methods[0])
    };
    let Some(method) = selected else {
        let mut ids: Vec<_> = methods.iter().map(|method| method.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        return Err(anyhow!(
            "select an OAuth METHOD_ID explicitly; available method IDs: {}",
            if ids.is_empty() {
                "(none)".into()
            } else {
                ids.join(", ")
            }
        ));
    };
    let answer = match method.form.as_ref() {
        None => None,
        Some(Value::Array(fields)) if fields.is_empty() => None,
        Some(Value::Array(_)) | Some(_) => {
            return Err(anyhow!(
                "This OAuth method needs form answers; use Settings for supported forms"
            ));
        }
    };
    let start = client
        .operator_oauth_start(provider, &method.id, answer, token)
        .await?;
    println!("{} OAuth", provider_name(provider));
    if let Some(url) = &start.url {
        println!("\nOpen this URL in your browser:\n\n{url}");
    }
    if let Some(instructions) = &start.instructions {
        println!("\n{instructions}");
    }

    let deadline = tokio::time::Instant::now() + oauth_timeout(&start.time);
    if start.mode == "code" {
        let code = rpassword::prompt_password("\nPaste authorization code: ")?;
        if code.trim().is_empty() {
            return Err(anyhow!("authorization code cannot be empty"));
        }
        let status = client
            .operator_oauth_complete(provider, &start.login_id, code.trim(), token)
            .await?;
        validate_oauth_status(&status)?;
        if status.status == "complete" {
            println!("Authenticated successfully.");
            return Ok(());
        }
    } else if start.mode != "auto" {
        return Err(anyhow!("unsupported OAuth mode"));
    }

    println!("\nWaiting for authorization...");
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("OAuth authorization timed out"));
        }
        sleep(Duration::from_secs(1)).await;
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("OAuth authorization timed out"));
        }
        let status = client
            .operator_oauth_status(provider, &start.login_id, token)
            .await?;
        validate_oauth_status(&status)?;
        if status.status == "complete" {
            println!("Authenticated successfully.");
            return Ok(());
        }
    }
}

fn oauth_timeout(time: &Option<Value>) -> Duration {
    Duration::from_secs(
        time.as_ref()
            .and_then(Value::as_u64)
            .unwrap_or(600)
            .clamp(1, 600),
    )
}

fn validate_oauth_status(status: &OperatorOAuthStatus) -> Result<()> {
    match status.status.as_str() {
        "pending" => Ok(()),
        "complete" if status.kind.as_deref().is_none_or(|kind| kind == "oauth") => Ok(()),
        "complete" => Err(anyhow!(
            "OAuth completed with an unexpected credential kind"
        )),
        "failed" | "expired" => Err(anyhow!("OAuth authorization {}", status.status)),
        _ => Err(anyhow!("unexpected OAuth authorization status")),
    }
}

fn validate_provider_id(provider: &str) -> Result<()> {
    let bytes = provider.as_bytes();
    if !(1..=63).contains(&bytes.len())
        || !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        || matches!(provider, "." | "..")
    {
        return Err(anyhow!("provider must match [a-z0-9][a-z0-9._-]{{0,62}}"));
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
        println!(
            "{:<24} {:<16} {:<14} {:<14}",
            "SESSION", "PROJECT", "ENVIRONMENT", "EXECUTION"
        );
        for session in sessions {
            println!(
                "{:<24} {:<16} {:<14} {}",
                session.id, session.project, session.environment_state, session.execution_state,
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
    async fn lists_provider_credential_metadata_with_operator_bearer() {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/provider-credentials")
                .header("authorization", "Bearer operator-secret");
            then.status(200).json_body(serde_json::json!([
                {"provider_id":"openai","generation":2,"created_at":"2026-10-01T00:00:00Z"}
            ]));
        });
        let credentials = ApiClient::new(&server.base_url())
            .unwrap()
            .provider_credentials("operator-secret")
            .await
            .unwrap();
        mock.assert_async().await;
        assert_eq!(credentials[0].provider_id, "openai");
        assert_eq!(credentials[0].generation, 2);
    }

    #[tokio::test]
    async fn sets_provider_credential_and_never_exposes_error_body() {
        let server = MockServer::start_async().await;
        let success = server.mock(|when, then| {
            when.method(httpmock::Method::PUT)
                .path("/v1/provider-credentials/openai")
                .header("authorization", "Bearer operator-secret")
                .json_body(serde_json::json!({"key":"private-key"}));
            then.status(200).json_body(serde_json::json!({
                "provider_id":"openai","generation":3,"created_at":"2026-10-02T00:00:00Z"
            }));
        });
        let metadata = ApiClient::new(&server.base_url())
            .unwrap()
            .set_provider_credential("openai", "private-key".into(), "operator-secret")
            .await
            .unwrap();
        success.assert_async().await;
        assert_eq!(metadata.generation, 3);

        let failure = server.mock(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/v1/provider-credentials");
            then.status(403).body("private response detail");
        });
        let error = ApiClient::new(&server.base_url())
            .unwrap()
            .provider_credentials("operator-secret")
            .await
            .unwrap_err()
            .to_string();
        failure.assert_async().await;
        assert!(error.contains("403"));
        assert!(!error.contains("private response detail"));
    }

    #[tokio::test]
    async fn dotted_provider_id_is_preserved_as_a_single_api_path_segment() {
        let server = MockServer::start_async().await;
        let request = server.mock(|when, then| {
            when.method(httpmock::Method::PUT)
                .path("/v1/provider-credentials/wafer.ai")
                .header("authorization", "Bearer operator-secret")
                .json_body(serde_json::json!({"key":"private-key"}));
            then.status(200).json_body(serde_json::json!({
                "provider_id":"wafer.ai","generation":1,"created_at":"2026-10-03T00:00:00Z"
            }));
        });
        validate_provider_id("wafer.ai").unwrap();
        ApiClient::new(&server.base_url())
            .unwrap()
            .set_provider_credential("wafer.ai", "private-key".into(), "operator-secret")
            .await
            .unwrap();
        request.assert_async().await;
    }

    #[test]
    fn parses_provider_credential_commands_and_validates_provider_id() {
        let cli = Cli::try_parse_from(["anvilctl", "provider-credentials", "list"]).unwrap();
        assert!(matches!(
            cli.command,
            CommandGroup::ProviderCredentials(ProviderCredentialsCommand {
                command: ProviderCredentialsSubcommand::List
            })
        ));
        let cli = Cli::try_parse_from(["anvilctl", "provider-credentials", "set", "my-provider1"])
            .unwrap();
        assert!(matches!(
            cli.command,
            CommandGroup::ProviderCredentials(ProviderCredentialsCommand {
                command: ProviderCredentialsSubcommand::Set { .. }
            })
        ));
        let cli = Cli::try_parse_from([
            "anvilctl",
            "provider-credentials",
            "oauth",
            "openai",
            "chatgpt-headless",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            CommandGroup::ProviderCredentials(ProviderCredentialsCommand {
                command: ProviderCredentialsSubcommand::Oauth { .. }
            })
        ));
        for valid in [
            "a",
            "openai",
            "provider-1",
            "wafer.ai",
            "opencode-go",
            "a_b.c-1",
            &"a".repeat(63),
        ] {
            assert!(validate_provider_id(valid).is_ok());
        }
        for invalid in [
            "", ".", "..", "../", "Upper", "foo/bar", "a?b", "a%b", "a:b", "a b", "_a", ".a", "a\n",
        ] {
            assert!(validate_provider_id(invalid).is_err());
        }
        assert!(validate_provider_id(&"a".repeat(64)).is_err());
    }

    #[tokio::test]
    async fn operator_oauth_methods_start_and_status_use_operator_bearer_and_get_polling() {
        let server = MockServer::start_async().await;
        let methods = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/provider-credentials/openai/methods")
                .header("authorization", "Bearer operator-secret");
            then.status(200).json_body(serde_json::json!({"methods":[
                {"id":"chatgpt-headless","label":"ChatGPT Headless"},
                {"id":"browser-callback","label":"Browser callback","form":[]}
            ]}));
        });
        let start = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/provider-credentials/openai/oauth")
                .header("authorization", "Bearer operator-secret")
                .json_body(serde_json::json!({"method_id":"chatgpt-headless"}));
            then.status(200).json_body(serde_json::json!({
                "login_id":"login-1","mode":"auto","url":"https://auth.example.test",
                "instructions":"Finish login","time":30
            }));
        });
        let status = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/provider-credentials/openai/oauth/login-1")
                .header("authorization", "Bearer operator-secret");
            then.status(200)
                .json_body(serde_json::json!({"status":"complete","kind":"oauth"}));
        });
        let complete = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/provider-credentials/openai/oauth/login-1/complete");
            then.status(500);
        });
        let client = ApiClient::new(&server.base_url()).unwrap();
        let methods_response = client
            .operator_auth_methods("openai", "operator-secret")
            .await
            .unwrap();
        assert_eq!(methods_response.methods[0].id, "chatgpt-headless");
        let flow = client
            .operator_oauth_start("openai", "chatgpt-headless", None, "operator-secret")
            .await
            .unwrap();
        assert_eq!(flow.mode, "auto");
        let result = client
            .operator_oauth_status("openai", &flow.login_id, "operator-secret")
            .await
            .unwrap();
        validate_oauth_status(&result).unwrap();
        methods.assert_async().await;
        start.assert_async().await;
        status.assert_async().await;
        assert_eq!(complete.hits_async().await, 0);
    }

    #[tokio::test]
    async fn operator_oauth_rejects_methods_with_forms_without_posting() {
        let server = MockServer::start_async().await;
        let methods = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/provider-credentials/example/methods")
                .header("authorization", "Bearer operator-secret");
            then.status(200).json_body(serde_json::json!({"methods":[
                {"id":"form-method","label":"Form method","form":[
                    {"type":"string","key":"region","title":"Region"}
                ]}
            ]}));
        });
        let start = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/provider-credentials/example/oauth");
            then.status(200).json_body(serde_json::json!({
                "login_id":"unexpected","mode":"auto"
            }));
        });

        let error = run_operator_oauth(
            &ApiClient::new(&server.base_url()).unwrap(),
            "example",
            Some("form-method"),
            "operator-secret",
        )
        .await
        .unwrap_err()
        .to_string();

        methods.assert_async().await;
        assert_eq!(start.hits_async().await, 0);
        assert!(error
            .contains("This OAuth method needs form answers; use Settings for supported forms"));
    }

    #[tokio::test]
    async fn operator_oauth_code_completion_posts_code_with_operator_bearer() {
        let server = MockServer::start_async().await;
        let complete = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/provider-credentials/example/oauth/login-2/complete")
                .header("authorization", "Bearer operator-secret")
                .json_body(serde_json::json!({"code":"private-code"}));
            then.status(200)
                .json_body(serde_json::json!({"status":"complete","kind":"oauth"}));
        });
        let result = ApiClient::new(&server.base_url())
            .unwrap()
            .operator_oauth_complete("example", "login-2", "private-code", "operator-secret")
            .await
            .unwrap();
        complete.assert_async().await;
        validate_oauth_status(&result).unwrap();
    }

    #[tokio::test]
    async fn operator_oauth_failures_discard_sensitive_response_body() {
        let server = MockServer::start_async().await;
        let failure = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/provider-credentials/example/methods")
                .header("authorization", "Bearer operator-secret");
            then.status(500)
                .body("raw OAuth access token must not be shown");
        });
        let error = ApiClient::new(&server.base_url())
            .unwrap()
            .operator_auth_methods("example", "operator-secret")
            .await
            .unwrap_err()
            .to_string();
        failure.assert_async().await;
        assert!(error.contains("500"));
        assert!(!error.contains("raw OAuth access token"));
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
