use std::sync::Mutex;
use std::time::{Duration, Instant};

use anvil_api::{CheckConclusion, CheckStatus, ExternalState};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{json, Value};

const TOKEN_CACHE_TTL: Duration = Duration::from_secs(50 * 60);

#[derive(Debug, Clone, PartialEq)]
pub struct Provisioned {
    pub target_sha: String,
    pub branch: String,
    pub pr_number: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PullInfo {
    pub number: i64,
    pub open: bool,
    pub mergeable: bool,
    pub head_sha: String,
    pub base_sha: String,
}

#[derive(Debug, thiserror::Error)]
pub enum GithubError {
    #[error("github responded {status}: {body}")]
    Api { status: u16, body: String },
    #[error("github transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("github response lacked the field {field}")]
    Malformed { field: &'static str },
    #[error("github auth: {0}")]
    Auth(String),
}

pub struct GithubClient {
    api_base: String,
    app_id: String,
    installation_id: i64,
    key: EncodingKey,
    client: reqwest::Client,
    token: Mutex<Option<(String, Instant)>>,
}

impl GithubClient {
    pub fn new(
        api_base: impl Into<String>,
        app_id: impl Into<String>,
        installation_id: i64,
        private_key_pem: &str,
    ) -> Result<Self, GithubError> {
        let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
            .map_err(|error| GithubError::Auth(error.to_string()))?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(concat!("anvil/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("static reqwest client options are valid");
        Ok(Self {
            api_base: api_base.into(),
            app_id: app_id.into(),
            installation_id,
            key,
            client,
            token: Mutex::new(None),
        })
    }

    pub async fn installation_token(&self) -> Result<String, GithubError> {
        self.token().await
    }

    async fn token(&self) -> Result<String, GithubError> {
        if let Some((token, minted)) = self.token.lock().unwrap().clone() {
            if minted.elapsed() < TOKEN_CACHE_TTL {
                return Ok(token);
            }
        }
        let now = unix_now();
        let jwt = jsonwebtoken::encode(
            &Header::new(Algorithm::RS256),
            &json!({"iss": self.app_id, "iat": now, "exp": now + 600}),
            &self.key,
        )
        .map_err(|error| GithubError::Auth(error.to_string()))?;
        let response = self
            .client
            .post(format!(
                "{}/app/installations/{}/access_tokens",
                self.api_base, self.installation_id
            ))
            .bearer_auth(jwt)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(GithubError::Api {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        let body: Value = response.json().await?;
        let token = body
            .get("token")
            .and_then(Value::as_str)
            .ok_or(GithubError::Malformed { field: "token" })?
            .to_owned();
        *self.token.lock().unwrap() = Some((token, Instant::now()));
        Ok(self.token.lock().unwrap().as_ref().unwrap().0.clone())
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, GithubError> {
        let token = self.token().await?;
        let mut request = self
            .client
            .request(
                method
                    .parse()
                    .map_err(|_| GithubError::Auth("bad method".to_owned()))?,
                format!("{}{path}", self.api_base),
            )
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "anvil");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(GithubError::Api {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        let text = response.text().await?;
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| GithubError::Malformed {
            field: "response body",
        })
    }

    pub async fn resolve_ref(&self, repo: &str, git_ref: &str) -> Result<String, GithubError> {
        let body = self
            .call(
                "GET",
                &format!("/repos/{repo}/git/ref/heads/{git_ref}"),
                None,
            )
            .await?;
        parse_ref(&body).ok_or(GithubError::Malformed { field: "ref sha" })
    }

    pub async fn create_branch(
        &self,
        repo: &str,
        branch: &str,
        sha: &str,
    ) -> Result<(), GithubError> {
        let result = self
            .call(
                "POST",
                &format!("/repos/{repo}/git/refs"),
                Some(json!({"ref": format!("refs/heads/{branch}"), "sha": sha})),
            )
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(GithubError::Api { status: 422, .. }) => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub async fn seed_commit(
        &self,
        repo: &str,
        branch: &str,
        base_sha: &str,
    ) -> Result<(), GithubError> {
        let commit = self
            .call(
                "GET",
                &format!("/repos/{repo}/git/commits/{base_sha}"),
                None,
            )
            .await?;
        let tree = commit
            .get("tree")
            .and_then(Value::as_object)
            .and_then(|tree| tree.get("sha"))
            .and_then(Value::as_str)
            .ok_or(GithubError::Malformed {
                field: "commit tree sha",
            })?;
        let created = self
            .call(
                "POST",
                &format!("/repos/{repo}/git/commits"),
                Some(json!({
                    "message": "anvil: begin",
                    "tree": tree,
                    "parents": [base_sha],
                })),
            )
            .await?;
        let sha = created
            .get("sha")
            .and_then(Value::as_str)
            .ok_or(GithubError::Malformed {
                field: "created commit sha",
            })?
            .to_owned();
        self.call(
            "PATCH",
            &format!("/repos/{repo}/git/refs/heads/{branch}"),
            Some(json!({"sha": sha})),
        )
        .await?;
        Ok(())
    }

    pub async fn pull_merged(&self, repo: &str, pr_number: i64) -> Result<bool, GithubError> {
        let body = self
            .call("GET", &format!("/repos/{repo}/pulls/{pr_number}"), None)
            .await?;
        Ok(body.get("state").and_then(Value::as_str) == Some("closed")
            && body.get("merged").and_then(Value::as_bool) == Some(true))
    }

    pub async fn pull(&self, repo: &str, pr_number: i64) -> Result<PullInfo, GithubError> {
        let body = self
            .call("GET", &format!("/repos/{repo}/pulls/{pr_number}"), None)
            .await?;
        parse_pull(&body).ok_or(GithubError::Malformed {
            field: "pull fields",
        })
    }

    pub async fn open_pr(
        &self,
        repo: &str,
        title: &str,
        head_branch: &str,
        base: &str,
        body: &str,
    ) -> Result<i64, GithubError> {
        let existing = self
            .call(
                "GET",
                &format!("/repos/{repo}/pulls?head={repo}:{head_branch}&state=open"),
                None,
            )
            .await?;
        if let Some(number) = parse_pull_list(&existing) {
            return Ok(number);
        }
        let created = self
            .call(
                "POST",
                &format!("/repos/{repo}/pulls"),
                Some(json!({
                    "title": title,
                    "head": head_branch,
                    "base": base,
                    "body": body,
                    "draft": true,
                })),
            )
            .await?;
        created
            .get("number")
            .and_then(Value::as_i64)
            .ok_or(GithubError::Malformed {
                field: "pull number",
            })
    }

    pub async fn check_runs(&self, repo: &str, sha: &str) -> Result<Vec<CheckStatus>, GithubError> {
        let body = self
            .call(
                "GET",
                &format!("/repos/{repo}/commits/{sha}/check-runs"),
                None,
            )
            .await?;
        Ok(parse_check_runs(&body))
    }

    pub async fn provision(
        &self,
        repo: &str,
        campaign_slug: &str,
        commission_slug: &str,
        target_ref: &str,
        title: &str,
        body: &str,
    ) -> Result<Provisioned, GithubError> {
        let target_sha = self.resolve_ref(repo, target_ref).await?;
        let branch = branch_name(campaign_slug, commission_slug)?;
        self.create_branch(repo, &branch, &target_sha).await?;
        if self.resolve_ref(repo, &branch).await? == target_sha {
            self.seed_commit(repo, &branch, &target_sha).await?;
        }
        let pr_number = self.open_pr(repo, title, &branch, target_ref, body).await?;
        Ok(Provisioned {
            target_sha,
            branch,
            pr_number,
        })
    }

    pub async fn external_state(
        &self,
        repo: &str,
        pr_number: i64,
        target_ref: &str,
        _admitted_target_sha: &str,
    ) -> Result<ExternalState, GithubError> {
        let pull = self.pull(repo, pr_number).await?;
        let checks = self.check_runs(repo, &pull.head_sha).await?;
        let commits = self
            .call(
                "GET",
                &format!("/repos/{repo}/pulls/{pr_number}/commits"),
                None,
            )
            .await?;
        let work_present = commits
            .as_array()
            .map(|commits| {
                commits.iter().any(|commit| {
                    commit
                        .get("commit")
                        .and_then(|inner| inner.get("message"))
                        .and_then(Value::as_str)
                        .is_some_and(|message| !message.starts_with("anvil: begin"))
                })
            })
            .unwrap_or(false);
        let current_target = self.resolve_ref(repo, target_ref).await?;
        Ok(ExternalState {
            checks,
            mergeable: pull.open && pull.mergeable,
            head_moved: pull.base_sha != current_target,
            work_present,
        })
    }
}

pub fn pr_body(spec: &str, obligations: &[String]) -> String {
    let mut out = String::new();
    let spec = spec.trim();
    if !spec.is_empty() {
        out.push_str(spec);
        out.push_str("\n\n");
    }
    if obligations.is_empty() {
        out.push_str("No obligations recorded yet.");
    } else {
        out.push_str("## Obligations\n\n");
        for text in obligations {
            out.push_str("- ");
            out.push_str(text);
            out.push('\n');
        }
    }
    out
}

fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

pub fn branch_name(campaign_slug: &str, commission_slug: &str) -> Result<String, GithubError> {
    let slug = |value: &str| {
        !value.is_empty()
            && value.len() <= 64
            && value
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    };
    if !slug(campaign_slug) {
        return Err(GithubError::Auth(format!(
            "campaign slug must be [a-z0-9-]: {campaign_slug}"
        )));
    }
    if !slug(commission_slug) {
        return Err(GithubError::Auth(format!(
            "commission slug must be [a-z0-9-]: {commission_slug}"
        )));
    }
    Ok(format!("anvil/{campaign_slug}/{commission_slug}"))
}

pub fn parse_ref(body: &Value) -> Option<String> {
    body.get("object")
        .and_then(|object| object.get("sha"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub fn parse_check_runs(body: &Value) -> Vec<CheckStatus> {
    body.get("check_runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|run| CheckStatus {
            name: run
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed")
                .to_owned(),
            conclusion: CheckConclusion::classify(
                run.get("conclusion").and_then(Value::as_str).unwrap_or(""),
            ),
        })
        .collect()
}

pub fn parse_pull(body: &Value) -> Option<PullInfo> {
    Some(PullInfo {
        number: body.get("number")?.as_i64()?,
        open: body.get("state")?.as_str()? == "open",
        mergeable: body
            .get("mergeable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        head_sha: body.get("head")?.get("sha")?.as_str()?.to_owned(),
        base_sha: body.get("base")?.get("sha")?.as_str()?.to_owned(),
    })
}

fn parse_pull_list(body: &Value) -> Option<i64> {
    body.as_array()?.first()?.get("number")?.as_i64()
}
