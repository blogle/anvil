//! Read-only GitHub REST implementation of the isolated CodeHost observation port.
use anvil_reconcile::github::{
    CheckRun, CommitStatus, GitHubReadPort, Policy, ProviderError, PullRequestFacts,
    RequiredContext,
};
use anvil_reconcile::EvaluationKind;
use reqwest::blocking::Client;
use reqwest::{Method, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

/// GitHub REST port with an explicit least-privilege token and API base URL.
/// This type has no write methods and never exposes raw provider response bodies.
pub struct GitHubRestPort {
    client: Client,
    api_base: Url,
    token: String,
}

impl GitHubRestPort {
    pub fn new(api_base: &str, token: impl Into<String>) -> Result<Self, String> {
        let mut api_base = Url::parse(api_base).map_err(|_| "invalid GitHub API URL")?;
        if !matches!(api_base.scheme(), "https" | "http") || api_base.host_str().is_none() {
            return Err("GitHub API base must be HTTP(S) with a host".into());
        }
        if !api_base.path().ends_with('/') {
            api_base.set_path(&format!("{}/", api_base.path()));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("anvil-read-only-codehost-observer")
            .build()
            .map_err(|_| "could not construct GitHub HTTP client")?;
        Ok(Self {
            client,
            api_base,
            token: token.into(),
        })
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, ProviderError> {
        let mut url = self
            .api_base
            .join(".")
            .map_err(|_| ProviderError::InvalidResponse)?;
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| ProviderError::InvalidResponse)?;
            path.pop_if_empty();
            path.extend(segments.iter().copied());
        }
        Ok(url)
    }

    fn owner_repo(repository: &str) -> Result<(&str, &str), ProviderError> {
        match repository.split_once('/') {
            Some((owner, repo)) if !owner.is_empty() && !repo.is_empty() && !repo.contains('/') => {
                Ok((owner, repo))
            }
            _ => Err(ProviderError::InvalidResponse),
        }
    }

    fn get(&self, url: Url) -> Result<Value, ProviderError> {
        let response = self
            .client
            .request(Method::GET, url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .map_err(|_| ProviderError::Unavailable)?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS
            || status == StatusCode::FORBIDDEN
                && response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|value| value == "0")
        {
            return Err(ProviderError::RateLimited);
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
            return Err(ProviderError::PermissionDenied);
        }
        if !status.is_success() {
            return Err(ProviderError::Unavailable);
        }
        response
            .json::<Value>()
            .map_err(|_| ProviderError::InvalidResponse)
    }

    fn get_optional(&self, url: Url) -> Result<Option<Value>, ProviderError> {
        let response = self
            .client
            .request(Method::GET, url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .map_err(|_| ProviderError::Unavailable)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS
            || status == StatusCode::FORBIDDEN
                && response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|value| value == "0")
        {
            return Err(ProviderError::RateLimited);
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
            return Err(ProviderError::PermissionDenied);
        }
        if !status.is_success() {
            return Err(ProviderError::Unavailable);
        }
        response
            .json::<Value>()
            .map(Some)
            .map_err(|_| ProviderError::InvalidResponse)
    }
}

impl GitHubReadPort for GitHubRestPort {
    fn branch_exists(&self, repository: &str, branch: &str) -> Result<bool, ProviderError> {
        let (owner, repo) = Self::owner_repo(repository)?;
        let url = self.endpoint(&["repos", owner, repo, "branches", branch])?;
        self.get_optional(url).map(|branch| branch.is_some())
    }

    fn pull_request(
        &self,
        repository: &str,
        branch: &str,
        bound_number: Option<u64>,
    ) -> Result<Option<PullRequestFacts>, ProviderError> {
        let (owner, repo) = Self::owner_repo(repository)?;
        let value = if let Some(number) = bound_number {
            self.get_optional(self.endpoint(&[
                "repos",
                owner,
                repo,
                "pulls",
                &number.to_string(),
            ])?)?
        } else {
            let mut url = self.endpoint(&["repos", owner, repo, "pulls"])?;
            url.query_pairs_mut()
                .append_pair("state", "all")
                .append_pair("head", &format!("{owner}:{branch}"))
                .append_pair("per_page", "100");
            let matches = self.get(url)?;
            let Some(pulls) = matches.as_array() else {
                return Err(ProviderError::InvalidResponse);
            };
            pulls
                .iter()
                .filter(|pull| {
                    pull.pointer("/head/ref").and_then(Value::as_str) == Some(branch)
                        && pull.pointer("/base/repo/full_name").and_then(Value::as_str)
                            == Some(repository)
                })
                .max_by_key(|pull| pull.get("number").and_then(Value::as_u64).unwrap_or(0))
                .cloned()
        };
        value
            .map(|pull| {
                let number = pull
                    .get("number")
                    .and_then(Value::as_u64)
                    .ok_or(ProviderError::InvalidResponse)?;
                let head_sha = pull
                    .pointer("/head/sha")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned();
                let merge_candidate = pull.get("merge_commit_sha").and_then(Value::as_str);
                let (evaluation_sha, evaluation_kind) = merge_candidate
                    .filter(|sha| !sha.is_empty() && *sha != head_sha)
                    .map(|sha| (sha.to_owned(), EvaluationKind::TestMerge))
                    .unwrap_or_else(|| (head_sha.clone(), EvaluationKind::Head));
                let merged = pull.get("merged").and_then(Value::as_bool).unwrap_or(false)
                    || pull.get("merged_at").is_some_and(|value| !value.is_null());
                let state = if merged {
                    "merged"
                } else {
                    pull.get("state")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::InvalidResponse)?
                }
                .to_owned();
                Ok(PullRequestFacts {
                    number,
                    head_sha,
                    evaluation_sha,
                    evaluation_kind,
                    state,
                    merged,
                })
            })
            .transpose()
    }

    fn required_policy(&self, repository: &str, base_ref: &str) -> Result<Policy, ProviderError> {
        let (owner, repo) = Self::owner_repo(repository)?;
        let mut required = Vec::new();

        // Classic branch-protection contexts may require commit statuses or check runs.
        let protection = self.get_optional(self.endpoint(&[
            "repos",
            owner,
            repo,
            "branches",
            base_ref,
            "protection",
            "required_status_checks",
        ])?)?;
        if let Some(protection) = protection {
            for context in protection
                .get("contexts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                required.push(RequiredContext {
                    context: context.to_owned(),
                    source: "status".into(),
                });
            }
            for check in protection
                .get("checks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(context) = check.get("context").and_then(Value::as_str) {
                    required.push(RequiredContext {
                        context: context.to_owned(),
                        source: "check_run".into(),
                    });
                }
            }
        }

        // Effective active branch rules include repository/org rulesets.
        let rules = self.get_optional(self.endpoint(&[
            "repos",
            owner,
            repo,
            "rules",
            "branches",
            base_ref,
        ])?)?;
        let Some(rules) = rules else {
            return Ok(Policy::Unavailable);
        };
        let Some(rules) = rules.as_array() else {
            return Err(ProviderError::InvalidResponse);
        };
        for rule in rules.iter().filter(|rule| {
            rule.get("type").and_then(Value::as_str) == Some("required_status_checks")
        }) {
            for check in rule
                .pointer("/parameters/required_status_checks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(context) = check.get("context").and_then(Value::as_str) {
                    let source = if check
                        .get("integration_id")
                        .is_some_and(|value| !value.is_null())
                    {
                        "check_run"
                    } else {
                        "status"
                    };
                    required.push(RequiredContext {
                        context: context.to_owned(),
                        source: source.into(),
                    });
                }
            }
        }
        required.sort_by(|left, right| {
            (&left.context, &left.source).cmp(&(&right.context, &right.source))
        });
        required.dedup_by(|left, right| {
            left.context == right.context && left.source == right.source
        });
        Ok(Policy::Known(required))
    }

    fn check_runs(
        &self,
        repository: &str,
        evaluation_sha: &str,
    ) -> Result<Vec<CheckRun>, ProviderError> {
        let (owner, repo) = Self::owner_repo(repository)?;
        let mut url = self.endpoint(&["repos", owner, repo, "commits", evaluation_sha, "check-runs"])?;
        url.query_pairs_mut().append_pair("per_page", "100");
        let value = self.get(url)?;
        value
            .get("check_runs")
            .and_then(Value::as_array)
            .ok_or(ProviderError::InvalidResponse)?
            .iter()
            .map(|run| {
                let name = run
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned();
                let sha = run
                    .get("head_sha")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned();
                let status = run
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned();
                let conclusion = run
                    .get("conclusion")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let run_id=run.get("id").and_then(Value::as_u64).unwrap_or(0);
                let updated_at=run.get("updated_at").and_then(Value::as_str).map(ToOwned::to_owned);
                let stable = format!(
                    "{}:{}:{}:{}",
                    run_id,
                    name,
                    status,
                    conclusion.as_deref().unwrap_or("pending")
                );
                let details_fingerprint=Sha256::digest(stable.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect();
                Ok(CheckRun {
                    run_id,
                    name,
                    sha,
                    conclusion,
                    status,
                    updated_at,
                    details_fingerprint: Some(details_fingerprint),
                })
            })
            .collect()
    }

    fn commit_statuses(
        &self,
        repository: &str,
        evaluation_sha: &str,
    ) -> Result<Vec<CommitStatus>, ProviderError> {
        let (owner, repo) = Self::owner_repo(repository)?;
        let mut url = self.endpoint(&["repos", owner, repo, "commits", evaluation_sha, "statuses"])?;
        url.query_pairs_mut().append_pair("per_page", "100");
        self.get(url)?
            .as_array()
            .ok_or(ProviderError::InvalidResponse)?
            .iter()
            .map(|status| {
                Ok(CommitStatus {
                    context: status
                        .get("context")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::InvalidResponse)?
                        .to_owned(),
                    sha: status
                        .get("sha")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::InvalidResponse)?
                        .to_owned(),
                    state: status
                        .get("state")
                        .and_then(Value::as_str)
                        .ok_or(ProviderError::InvalidResponse)?
                        .to_owned(),
                    updated_at:status.get("updated_at").and_then(Value::as_str).map(ToOwned::to_owned),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anvil_reconcile::github::{GitHubCodeHost, ObservationRequest};
    use httpmock::prelude::*;
    use serde_json::json;

    #[test]
    fn observes_exact_branch_pr_test_merge_policy_checks_and_statuses_read_only() {
        let server = MockServer::start();
        let branch = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/branches/anvil%2Ftask");
            then.status(200).json_body(json!({"name":"anvil/task","commit":{"sha":"base"}}));
        });
        let pulls = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/pulls").query_param("head","org:anvil/task");
            then.status(200).json_body(json!([{"number":42,"state":"open","merged":false,"head":{"ref":"anvil/task","sha":"head-sha"},"base":{"ref":"main","repo":{"full_name":"org/repo"}},"merge_commit_sha":"test-merge-sha"}]));
        });
        let protection = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/branches/main/protection/required_status_checks");
            then.status(200).json_body(json!({"contexts":["legacy"],"checks":[{"context":"lint","app_id":9}]}));
        });
        let rules = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/rules/branches/main");
            then.status(200).json_body(json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CI","integration_id":9}]}}]));
        });
        let checks = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/commits/test-merge-sha/check-runs").query_param("per_page","100");
            then.status(200).json_body(json!({"check_runs":[{"id":5,"name":"CI","head_sha":"test-merge-sha","status":"completed","conclusion":"success"},{"id":6,"name":"lint","head_sha":"test-merge-sha","status":"completed","conclusion":"neutral"}]}));
        });
        let statuses = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/commits/test-merge-sha/statuses").query_param("per_page","100");
            then.status(200).json_body(json!([{"context":"legacy","sha":"test-merge-sha","state":"success"}]));
        });
        let port=GitHubRestPort::new(&server.url("/"),"test-token").unwrap();
        let observed=GitHubCodeHost::new(port).observe(&ObservationRequest{repository:"org/repo".into(),base_ref:"main".into(),work_branch:"anvil/task".into(),bound_pr_number:None}).unwrap();
        assert_eq!(observed.pull_request.as_ref().unwrap().number,42);
        assert_eq!(observed.pull_request.as_ref().unwrap().head_sha,"head-sha");
        assert_eq!(observed.pull_request.as_ref().unwrap().evaluation_sha,"test-merge-sha");
        assert_eq!(observed.pull_request.as_ref().unwrap().evaluation_kind,EvaluationKind::TestMerge);
        assert_eq!(observed.required_checks.iter().map(|c|c.context.as_str()).collect::<Vec<_>>(),["CI","legacy","lint"]);
        assert!(observed.required_checks.iter().all(|c|c.state==anvil_reconcile::CheckState::Passing));
        for mock in [branch,pulls,protection,rules,checks,statuses] { mock.assert(); }
        assert!(server.received_requests().iter().all(|request|request.method=="GET"),"observer must not send merge/write requests");
    }

    #[test]
    fn inaccessible_effective_rules_return_unknown_not_green() {
        let server=MockServer::start();
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/branches/anvil%2Ftask");then.status(200).json_body(json!({"name":"anvil/task"}));});
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/pulls");then.status(200).json_body(json!([{"number":42,"state":"open","head":{"ref":"anvil/task","sha":"h"},"base":{"ref":"main","repo":{"full_name":"org/repo"}}}]));});
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/branches/main/protection/required_status_checks");then.status(404);});
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/rules/branches/main");then.status(403);});
        let port=GitHubRestPort::new(&server.url("/"),"test-token").unwrap();
        let observed=GitHubCodeHost::new(port).observe(&ObservationRequest{repository:"org/repo".into(),base_ref:"main".into(),work_branch:"anvil/task".into(),bound_pr_number:None}).unwrap();
        assert!(!observed.required_policy_known);
        assert!(observed.required_checks.is_empty());
    }
}
