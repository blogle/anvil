use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use thiserror::Error;
use tracing::warn;

type HmacSha256 = Hmac<Sha256>;

const CAPABILITY_CLASS: &str = "github-repository";
const REFRESH_MARGIN: ChronoDuration = ChronoDuration::seconds(60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityClaims {
    pub session_id: String,
    pub repository: String,
    pub capability: String,
    pub expires_at: i64,
}

#[derive(Clone)]
pub struct CapabilitySigner {
    secret: Arc<Vec<u8>>,
    ttl: Duration,
}

impl CapabilitySigner {
    pub fn new(secret: impl AsRef<[u8]>, ttl: Duration) -> Result<Self, String> {
        let secret = secret.as_ref().to_vec();
        if secret.len() < 32 {
            return Err("ANVIL_SESSION_SIGNING_SECRET must be at least 32 bytes".into());
        }
        Ok(Self {
            secret: Arc::new(secret),
            ttl,
        })
    }

    pub fn mint(&self, session_id: &str, repository: &str) -> Result<String, String> {
        let expires_at = Utc::now()
            .checked_add_signed(ChronoDuration::from_std(self.ttl).map_err(|e| e.to_string())?)
            .ok_or_else(|| "capability expiry overflowed".to_owned())?
            .timestamp();
        let claims = CapabilityClaims {
            session_id: session_id.to_owned(),
            repository: repository.to_owned(),
            capability: CAPABILITY_CLASS.into(),
            expires_at,
        };
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|e| e.to_string())?);
        let mut mac = HmacSha256::new_from_slice(&self.secret).map_err(|e| e.to_string())?;
        mac.update(payload.as_bytes());
        Ok(format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }

    pub fn verify(&self, token: &str) -> Result<CapabilityClaims, String> {
        let (payload, signature) = token
            .split_once('.')
            .ok_or_else(|| "malformed session capability".to_owned())?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| "malformed session capability signature".to_owned())?;
        let mut mac = HmacSha256::new_from_slice(&self.secret).map_err(|e| e.to_string())?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| "invalid session capability".to_owned())?;
        let claims: CapabilityClaims = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| "malformed session capability payload".to_owned())?,
        )
        .map_err(|_| "malformed session capability payload".to_owned())?;
        if claims.capability != CAPABILITY_CLASS || claims.expires_at <= Utc::now().timestamp() {
            return Err("expired or unsupported session capability".into());
        }
        Ok(claims)
    }
}

#[derive(Debug, Clone)]
pub struct GithubConfig {
    pub app_id: String,
    pub installation_id: u64,
    pub private_key: String,
    pub api_url: Url,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubCredential {
    pub token: String,
    pub token_type: &'static str,
    pub expires_at: String,
    pub repository: String,
    pub permissions: HashMap<&'static str, &'static str>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum GithubCredentialPurpose {
    #[default]
    Legacy,
    Git,
    GhRead,
}

impl GithubCredentialPurpose {
    pub(crate) fn permissions(self) -> HashMap<&'static str, &'static str> {
        match self {
            Self::Git => HashMap::from([("contents", "write")]),
            Self::GhRead => HashMap::from([
                ("actions", "read"),
                ("checks", "read"),
                ("contents", "read"),
                ("metadata", "read"),
                ("pull_requests", "read"),
            ]),
            Self::Legacy => HashMap::from([
                ("actions", "read"),
                ("checks", "read"),
                ("contents", "write"),
                ("issues", "read"),
                ("metadata", "read"),
                ("pull_requests", "read"),
                ("statuses", "read"),
            ]),
        }
    }
}

#[derive(Debug, Error)]
pub enum GithubError {
    #[error("invalid GitHub repository: {0}")]
    Repository(String),
    #[error("GitHub App configuration error: {0}")]
    Configuration(String),
    #[error("GitHub App JWT error: {0}")]
    Jwt(String),
    #[error("GitHub token request transport failed: {0}")]
    Transport(String),
    #[error("GitHub token request failed: {message}")]
    Upstream {
        code: String,
        status: u16,
        message: String,
        request_id: Option<String>,
        documentation_url: Option<String>,
    },
    #[error("GitHub returned a malformed token response")]
    MalformedResponse {
        status: u16,
        request_id: Option<String>,
    },
    #[error("GitHub token cache unavailable")]
    Cache,
}

#[derive(Debug, Serialize)]
pub struct GithubDiagnostic {
    pub code: String,
    pub message: String,
    pub upstream_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
}

impl GithubError {
    pub fn diagnostic(&self) -> GithubDiagnostic {
        match self {
            Self::Upstream {
                code,
                status,
                message,
                request_id,
                documentation_url,
            } => GithubDiagnostic {
                code: code.clone(),
                message: message.clone(),
                upstream_status: Some(*status),
                github_request_id: request_id.clone(),
                documentation_url: documentation_url.clone(),
            },
            Self::MalformedResponse { status, request_id } => GithubDiagnostic {
                code: "github_malformed_response".into(),
                message: "GitHub returned a malformed installation-token response".into(),
                upstream_status: Some(*status),
                github_request_id: request_id.clone(),
                documentation_url: None,
            },
            Self::Configuration(message) => GithubDiagnostic {
                code: "github_app_configuration_error".into(),
                message: message.clone(),
                upstream_status: None,
                github_request_id: None,
                documentation_url: None,
            },
            Self::Jwt(message) => GithubDiagnostic {
                code: "github_app_jwt_error".into(),
                message: message.clone(),
                upstream_status: None,
                github_request_id: None,
                documentation_url: None,
            },
            Self::Transport(message) => GithubDiagnostic {
                code: "github_transport_error".into(),
                message: message.clone(),
                upstream_status: None,
                github_request_id: None,
                documentation_url: None,
            },
            Self::Repository(message) => GithubDiagnostic {
                code: "github_repository_validation_failed".into(),
                message: message.clone(),
                upstream_status: None,
                github_request_id: None,
                documentation_url: None,
            },
            Self::Cache => GithubDiagnostic {
                code: "github_token_cache_unavailable".into(),
                message: "GitHub token cache unavailable".into(),
                upstream_status: None,
                github_request_id: None,
                documentation_url: None,
            },
        }
    }
}

#[derive(Debug, Clone)]
struct CachedToken {
    credential: GithubCredential,
    expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct GithubBroker {
    client: Client,
    config: GithubConfig,
    cache: Arc<Mutex<HashMap<String, CachedToken>>>,
    #[cfg(test)]
    jwt_override: Option<String>,
}

impl GithubBroker {
    pub fn new(config: GithubConfig) -> Self {
        Self {
            client: Client::builder()
                .user_agent("anvil-github-broker/0.1")
                .build()
                .expect("GitHub broker HTTP client configuration is valid"),
            config,
            cache: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            jwt_override: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_jwt(self, jwt: &str) -> Self {
        Self {
            jwt_override: Some(jwt.into()),
            ..self
        }
    }

    pub async fn credential(
        &self,
        repository: &str,
        purpose: GithubCredentialPurpose,
    ) -> Result<GithubCredential, GithubError> {
        let (owner, name) = github_repository(repository).map_err(GithubError::Repository)?;
        let key = format!("{owner}/{name}").to_ascii_lowercase();
        let key = format!("{key}\0{purpose:?}");
        if let Some(cached) = self
            .cache
            .lock()
            .map_err(|_| GithubError::Cache)?
            .get(&key)
            .filter(|cached| cached.expires_at > Utc::now() + REFRESH_MARGIN)
            .cloned()
        {
            return Ok(cached.credential);
        }

        let app_jwt = self.app_jwt().map_err(GithubError::Jwt)?;
        let url = self
            .config
            .api_url
            .join(&format!(
                "app/installations/{}/access_tokens",
                self.config.installation_id
            ))
            .map_err(|e| GithubError::Configuration(format!("invalid token URL: {e}")))?;
        let mut response = self
            .client
            .post(url)
            .bearer_auth(app_jwt)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .json(&serde_json::json!({
                "repositories": [name],
                "permissions": purpose.permissions(),
            }))
            .send()
            .await
            .map_err(|e| GithubError::Transport(e.to_string()))?;
        let status = response.status();
        let request_id = response
            .headers()
            .get("x-github-request-id")
            .and_then(|value| value.to_str().ok())
            .map(sanitize_text);
        if !status.is_success() {
            let body = read_bounded_body(&mut response).await?;
            warn!(
                status = status.as_u16(),
                request_id = request_id.as_deref().unwrap_or(""),
                body_bytes = body.len(),
                content_type = response
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or(""),
                "GitHub installation-token request rejected"
            );
            let upstream = serde_json::from_slice::<GithubErrorResponse>(&body).ok();
            return Err(GithubError::Upstream {
                code: upstream_code(status.as_u16()),
                status: status.as_u16(),
                message: upstream
                    .as_ref()
                    .and_then(|body| body.message.as_deref())
                    .map(sanitize_text)
                    .unwrap_or_else(|| "GitHub rejected the installation-token request".into()),
                request_id,
                documentation_url: upstream
                    .as_ref()
                    .and_then(|body| body.documentation_url.as_deref())
                    .map(sanitize_text),
            });
        }
        let body = read_bounded_body(&mut response).await?;
        let body: GithubTokenResponse =
            serde_json::from_slice(&body).map_err(|_| GithubError::MalformedResponse {
                status: status.as_u16(),
                request_id: request_id.clone(),
            })?;
        let expires_at = DateTime::parse_from_rfc3339(&body.expires_at)
            .map_err(|_| GithubError::MalformedResponse {
                status: status.as_u16(),
                request_id: request_id.clone(),
            })?
            .with_timezone(&Utc);
        let credential = GithubCredential {
            token: body.token,
            token_type: "installation",
            expires_at: expires_at.to_rfc3339(),
            repository: format!("{owner}/{name}"),
            permissions: purpose.permissions(),
        };
        self.cache.lock().map_err(|_| GithubError::Cache)?.insert(
            key,
            CachedToken {
                credential: credential.clone(),
                expires_at,
            },
        );
        Ok(credential)
    }

    fn app_jwt(&self) -> Result<String, String> {
        #[cfg(test)]
        if let Some(jwt) = &self.jwt_override {
            return Ok(jwt.clone());
        }
        #[derive(Serialize)]
        struct Claims {
            iat: i64,
            exp: i64,
            iss: String,
        }
        let now = Utc::now().timestamp();
        let mut header = Header::new(Algorithm::RS256);
        header.typ = Some("JWT".into());
        encode(
            &header,
            &Claims {
                iat: now - 60,
                exp: now + 9 * 60,
                iss: self.config.app_id.clone(),
            },
            &EncodingKey::from_rsa_pem(self.config.private_key.as_bytes())
                .map_err(|e| format!("invalid GitHub App private key: {e}"))?,
        )
        .map_err(|e| format!("failed to sign GitHub App JWT: {e}"))
    }
}

const MAX_GITHUB_BODY_BYTES: usize = 64 * 1024;

async fn read_bounded_body(response: &mut reqwest::Response) -> Result<Vec<u8>, GithubError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| GithubError::Transport(error.to_string()))?
    {
        let remaining = MAX_GITHUB_BODY_BYTES.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    Ok(body)
}

fn sanitize_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect()
}

fn upstream_code(status: u16) -> String {
    match status {
        401 => "github_app_authentication_failed",
        403 => "github_upstream_forbidden",
        404 => "github_installation_repository_mismatch",
        422 => "github_token_scope_rejected",
        500..=599 => "github_upstream_failure",
        _ => "github_upstream_rejected",
    }
    .into()
}

#[derive(Debug, Deserialize)]
struct GithubTokenResponse {
    token: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct GithubErrorResponse {
    message: Option<String>,
    documentation_url: Option<String>,
}

pub fn github_repository(repository: &str) -> Result<(String, String), String> {
    let url = url::Url::parse(repository).map_err(|e| format!("invalid repository URL: {e}"))?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
    {
        return Err("GitHub credentials require an HTTPS github.com repository".into());
    }
    let parts = url
        .path_segments()
        .ok_or_else(|| "repository URL has no owner/repository path".to_owned())?
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err("repository URL must be github.com/<owner>/<repository>".into());
    }
    let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    if name.is_empty() {
        return Err("repository name must not be empty".into());
    }
    Ok((parts[0].to_owned(), name.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::{Method::POST, MockServer};
    use std::collections::BTreeSet;

    #[test]
    fn capabilities_bind_session_and_repository() {
        let signer = CapabilitySigner::new("x".repeat(32), Duration::from_secs(60)).unwrap();
        let token = signer
            .mint("demo-12345678", "https://github.com/acme/demo.git")
            .unwrap();
        let claims = signer.verify(&token).unwrap();
        assert_eq!(claims.session_id, "demo-12345678");
        assert_eq!(claims.repository, "https://github.com/acme/demo.git");
    }

    #[test]
    fn capabilities_reject_tampering_and_expiry() {
        let signer = CapabilitySigner::new("x".repeat(32), Duration::from_secs(60)).unwrap();
        let token = signer
            .mint("demo-12345678", "https://github.com/acme/demo.git")
            .unwrap();
        assert!(signer.verify(&format!("{token}x")).is_err());
        let expired = CapabilitySigner::new("x".repeat(32), Duration::from_secs(0)).unwrap();
        assert!(expired
            .mint("demo-12345678", "repo")
            .and_then(|token| expired.verify(&token))
            .is_err());
    }

    #[test]
    fn repository_binding_is_narrow() {
        assert_eq!(
            github_repository("https://github.com/Acme/demo.git").unwrap(),
            ("Acme".into(), "demo".into())
        );
        assert!(github_repository("https://github.com/Acme/demo/issues").is_err());
        assert!(github_repository("https://example.com/Acme/demo").is_err());
    }

    #[test]
    fn credential_profiles_are_explicit_and_least_privilege() {
        let git = GithubCredentialPurpose::Git.permissions();
        assert_eq!(git, HashMap::from([("contents", "write")]));

        let gh_read = GithubCredentialPurpose::GhRead.permissions();
        assert_eq!(gh_read.get("contents"), Some(&"read"));
        assert!(gh_read.values().all(|permission| *permission == "read"));
        assert_eq!(
            gh_read.keys().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from(["actions", "checks", "contents", "metadata", "pull_requests",])
        );

        assert_eq!(
            GithubCredentialPurpose::default(),
            GithubCredentialPurpose::Legacy
        );
        let legacy = GithubCredentialPurpose::Legacy.permissions();
        assert_eq!(legacy.get("contents"), Some(&"write"));
        assert_eq!(legacy.len(), 7);
    }

    #[tokio::test]
    async fn installation_tokens_are_cached_and_refreshed_near_expiry() {
        let server = MockServer::start_async().await;
        let expires_at = (Utc::now() + ChronoDuration::seconds(30)).to_rfc3339();
        let token = server.mock(|when, then| {
            when.method(POST)
                .path("/app/installations/42/access_tokens")
                .header("user-agent", "anvil-github-broker/0.1")
                .json_body(serde_json::json!({
                    "repositories": ["demo"],
                    "permissions": GithubCredentialPurpose::Git.permissions()
                }));
            then.status(201).json_body(serde_json::json!({
                "token": "ghs_test",
                "expires_at": expires_at
            }));
        });
        let broker = GithubBroker::new(GithubConfig {
            app_id: "1".into(),
            installation_id: 42,
            private_key: "not-used-in-test".into(),
            api_url: Url::parse(&server.base_url()).unwrap(),
        })
        .with_jwt("test-jwt");
        broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::Git,
            )
            .await
            .unwrap();
        broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::Git,
            )
            .await
            .unwrap();
        token.assert_hits(2);
    }

    #[tokio::test]
    async fn credential_purposes_have_isolated_cached_tokens() {
        let server = MockServer::start_async().await;
        let expires_at = (Utc::now() + ChronoDuration::hours(1)).to_rfc3339();
        let git = server.mock(|when, then| {
            when.method(POST)
                .path("/app/installations/42/access_tokens")
                .json_body(serde_json::json!({
                    "repositories": ["demo"],
                    "permissions": GithubCredentialPurpose::Git.permissions()
                }));
            then.status(201).json_body(serde_json::json!({
                "token": "ghs_git",
                "expires_at": expires_at
            }));
        });
        let gh = server.mock(|when, then| {
            when.method(POST)
                .path("/app/installations/42/access_tokens")
                .json_body(serde_json::json!({
                    "repositories": ["demo"],
                    "permissions": GithubCredentialPurpose::GhRead.permissions()
                }));
            then.status(201).json_body(serde_json::json!({
                "token": "ghs_gh",
                "expires_at": expires_at
            }));
        });
        let broker = GithubBroker::new(GithubConfig {
            app_id: "1".into(),
            installation_id: 42,
            private_key: "not-used-in-test".into(),
            api_url: Url::parse(&server.base_url()).unwrap(),
        })
        .with_jwt("test-jwt");

        let git_credential = broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::Git,
            )
            .await
            .unwrap();
        let gh_credential = broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::GhRead,
            )
            .await
            .unwrap();
        assert_eq!(git_credential.token, "ghs_git");
        assert_eq!(gh_credential.token, "ghs_gh");
        broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::Git,
            )
            .await
            .unwrap();
        broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::GhRead,
            )
            .await
            .unwrap();
        git.assert_hits(1);
        gh.assert_hits(1);
    }

    #[tokio::test]
    async fn upstream_failures_preserve_safe_structured_diagnostics() {
        let cases = [
            (401, "github_app_authentication_failed"),
            (403, "github_upstream_forbidden"),
            (404, "github_installation_repository_mismatch"),
            (422, "github_token_scope_rejected"),
            (500, "github_upstream_failure"),
        ];
        for (status, expected_code) in cases {
            let server = MockServer::start_async().await;
            server.mock(|when, then| {
                when.method(POST)
                    .path("/app/installations/42/access_tokens");
                then.status(status)
                    .header("x-github-request-id", "safe-request-id")
                    .json_body(serde_json::json!({
                        "message": "safe upstream message",
                        "documentation_url": "https://docs.github.com/safe"
                    }));
            });
            let broker = GithubBroker::new(GithubConfig {
                app_id: "1".into(),
                installation_id: 42,
                private_key: "not-used-in-test".into(),
                api_url: Url::parse(&server.base_url()).unwrap(),
            })
            .with_jwt("test-jwt");
            let error = broker
                .credential(
                    "https://github.com/acme/demo.git",
                    GithubCredentialPurpose::Git,
                )
                .await
                .unwrap_err();
            let diagnostic = error.diagnostic();
            assert_eq!(diagnostic.code, expected_code);
            assert_eq!(diagnostic.upstream_status, Some(status));
            assert_eq!(
                diagnostic.github_request_id.as_deref(),
                Some("safe-request-id")
            );
            assert_eq!(
                diagnostic.documentation_url.as_deref(),
                Some("https://docs.github.com/safe")
            );
            let serialized = serde_json::to_string(&diagnostic).unwrap();
            assert!(!serialized.contains("test-jwt"));
            assert!(!serialized.contains("ghs_"));
            assert!(!serialized.contains("private"));
        }
    }

    #[tokio::test]
    async fn transport_failures_are_typed_without_credential_material() {
        let broker = GithubBroker::new(GithubConfig {
            app_id: "1".into(),
            installation_id: 42,
            private_key: "not-used-in-test".into(),
            api_url: Url::parse("http://127.0.0.1:1").unwrap(),
        })
        .with_jwt("test-jwt");
        let error = broker
            .credential(
                "https://github.com/acme/demo.git",
                GithubCredentialPurpose::Git,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, GithubError::Transport(_)));
        assert_eq!(error.diagnostic().code, "github_transport_error");
    }
}
