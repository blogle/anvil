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
            client: Client::new(),
            config,
            cache: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            jwt_override: None,
        }
    }

    #[cfg(test)]
    fn with_jwt(self, jwt: &str) -> Self {
        Self {
            jwt_override: Some(jwt.into()),
            ..self
        }
    }

    pub async fn credential(&self, repository: &str) -> Result<GithubCredential, String> {
        let (owner, name) = github_repository(repository)?;
        let key = format!("{owner}/{name}").to_ascii_lowercase();
        if let Some(cached) = self
            .cache
            .lock()
            .map_err(|_| "GitHub token cache unavailable".to_owned())?
            .get(&key)
            .filter(|cached| cached.expires_at > Utc::now() + REFRESH_MARGIN)
            .cloned()
        {
            return Ok(cached.credential);
        }

        let app_jwt = self.app_jwt()?;
        let url = self
            .config
            .api_url
            .join(&format!(
                "app/installations/{}/access_tokens",
                self.config.installation_id
            ))
            .map_err(|e| e.to_string())?;
        let response = self
            .client
            .post(url)
            .bearer_auth(app_jwt)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .json(&serde_json::json!({
                "repositories": [name],
                "permissions": requested_permissions(),
            }))
            .send()
            .await
            .map_err(|e| format!("GitHub token request failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("GitHub token request returned {status}"));
        }
        let body: GithubTokenResponse = response
            .json()
            .await
            .map_err(|e| format!("invalid GitHub token response: {e}"))?;
        let expires_at = DateTime::parse_from_rfc3339(&body.expires_at)
            .map_err(|e| format!("invalid GitHub token expiry: {e}"))?
            .with_timezone(&Utc);
        let credential = GithubCredential {
            token: body.token,
            token_type: "installation",
            expires_at: expires_at.to_rfc3339(),
            repository: format!("{owner}/{name}"),
            permissions: requested_permissions(),
        };
        self.cache
            .lock()
            .map_err(|_| "GitHub token cache unavailable".to_owned())?
            .insert(
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

#[derive(Debug, Deserialize)]
struct GithubTokenResponse {
    token: String,
    expires_at: String,
}

pub fn requested_permissions() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("actions", "read"),
        ("checks", "read"),
        ("contents", "write"),
        ("issues", "read"),
        ("metadata", "read"),
        ("pull_requests", "read"),
        ("statuses", "read"),
    ])
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

    #[tokio::test]
    async fn installation_tokens_are_cached_and_refreshed_near_expiry() {
        let server = MockServer::start_async().await;
        let expires_at = (Utc::now() + ChronoDuration::seconds(30)).to_rfc3339();
        let token = server.mock(|when, then| {
            when.method(POST)
                .path("/app/installations/42/access_tokens")
                .json_body(serde_json::json!({
                    "repositories": ["demo"],
                    "permissions": requested_permissions()
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
            .credential("https://github.com/acme/demo.git")
            .await
            .unwrap();
        broker
            .credential("https://github.com/acme/demo.git")
            .await
            .unwrap();
        token.assert_hits(2);
    }
}
