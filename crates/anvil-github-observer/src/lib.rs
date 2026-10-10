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
use std::collections::BTreeMap;
use std::time::Duration;
use url::Url;

fn next_link(header: &str, api_base: &Url) -> Result<Option<Url>, ProviderError> {
    let Some(link) = header
        .split(',')
        .find(|link| link.contains("rel=\"next\"") || link.contains("rel=next"))
    else {
        return Ok(None);
    };
    let start = link.find('<').ok_or(ProviderError::InvalidResponse)? + 1;
    let end = link[start..]
        .find('>')
        .ok_or(ProviderError::InvalidResponse)?
        + start;
    let url = Url::parse(&link[start..end]).map_err(|_| ProviderError::InvalidResponse)?;
    if url.scheme() != api_base.scheme()
        || url.host_str() != api_base.host_str()
        || url.port_or_known_default() != api_base.port_or_known_default()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(Some(url))
}

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

    fn get_page(&self, url: Url) -> Result<(Value, Option<Url>), ProviderError> {
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
        let next = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|value| value.to_str().ok())
            .map(|header| next_link(header, &self.api_base))
            .transpose()?
            .flatten();
        let value = response
            .json::<Value>()
            .map_err(|_| ProviderError::InvalidResponse)?;
        Ok((value, next))
    }

    fn get_all_pages(
        &self,
        mut url: Url,
        array_key: Option<&str>,
    ) -> Result<Vec<Value>, ProviderError> {
        const MAX_PAGES: usize = 100;
        let mut rows = Vec::new();
        for _ in 0..MAX_PAGES {
            let (value, next) = self.get_page(url)?;
            let items = match array_key {
                Some(key) => value.get(key).and_then(Value::as_array),
                None => value.as_array(),
            }
            .ok_or(ProviderError::InvalidResponse)?;
            rows.extend(items.iter().cloned());
            match next {
                Some(next) => url = next,
                None => return Ok(rows),
            }
        }
        Err(ProviderError::InvalidResponse)
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

    /// GraphQL exposes a PR's merge-queue entry and its current merge-group head commit.
    /// `None` (outer) means inaccessible/unknown; `Some(None)` means not queued.
    fn merge_queue_head(&self, owner: &str, repo: &str, number: u64) -> Option<Option<String>> {
        let url = self.api_base.join("../graphql").ok()?;
        let query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{headCommit{oid}}}}}";
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(&serde_json::json!({"query":query,"variables":{"owner":owner,"name":repo,"number":number}}))
            .send()
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let value = response.json::<Value>().ok()?;
        if value.get("errors").is_some_and(|errors| !errors.is_null()) {
            return None;
        }
        let pull = value.pointer("/data/repository/pullRequest")?;
        let entry = pull.get("mergeQueueEntry")?;
        if entry.is_null() {
            return Some(None);
        }
        Some(Some(
            entry
                .pointer("/headCommit/oid")
                .and_then(Value::as_str)?
                .to_owned(),
        ))
    }

    fn pull_request_review_state(&self, owner: &str, repo: &str, number: u64) -> (bool, bool) {
        let result = (|| {
            let mut url = self.endpoint(&[
                "repos",
                owner,
                repo,
                "pulls",
                &number.to_string(),
                "reviews",
            ])?;
            url.query_pairs_mut()
                .append_pair("per_page", "100")
                .append_pair("page", "1");
            let reviews = self.get_all_pages(url, None)?;
            let mut latest = BTreeMap::new();
            for review in reviews {
                let login = review
                    .pointer("/user/login")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::InvalidResponse)?;
                let state = review
                    .get("state")
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::InvalidResponse)?;
                let submitted_at = review
                    .get("submitted_at")
                    .and_then(Value::as_str)
                    .or_else(|| review.get("updated_at").and_then(Value::as_str))
                    .ok_or(ProviderError::InvalidResponse)?;
                let review_id = review.get("id").and_then(Value::as_u64).unwrap_or_default();
                let candidate = (submitted_at.to_owned(), review_id, state.to_owned());
                if latest
                    .get(login)
                    .is_none_or(|previous| previous < &candidate)
                {
                    latest.insert(login.to_owned(), candidate);
                }
            }
            Ok::<_, ProviderError>(
                latest
                    .values()
                    .any(|(_, _, state)| state == "CHANGES_REQUESTED"),
            )
        })();
        match result {
            Ok(changes_requested) => (changes_requested, true),
            Err(_) => (false, false),
        }
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
            self.get_all_pages(url, None)?
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
                let merge_group = self.merge_queue_head(owner, repo, number);
                let (evaluation_sha, evaluation_kind, evaluation_identity_known) = match merge_group
                {
                    Some(Some(sha)) => (sha, EvaluationKind::MergeGroup, true),
                    Some(None) => (evaluation_sha, evaluation_kind, true),
                    None => (evaluation_sha, evaluation_kind, false),
                };
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
                let (changes_requested, review_state_known) =
                    self.pull_request_review_state(owner, repo, number);
                Ok(PullRequestFacts {
                    number,
                    head_sha,
                    evaluation_sha,
                    evaluation_kind,
                    evaluation_identity_known,
                    changes_requested,
                    review_state_known,
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
        let mut rules_url =
            self.endpoint(&["repos", owner, repo, "rules", "branches", base_ref])?;
        rules_url
            .query_pairs_mut()
            .append_pair("per_page", "100")
            .append_pair("page", "1");
        let rules = match self.get_all_pages(rules_url, None) {
            Ok(rules) => rules,
            Err(
                ProviderError::Unavailable
                | ProviderError::PermissionDenied
                | ProviderError::RateLimited,
            ) => return Ok(Policy::Unavailable),
            Err(error) => return Err(error),
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
        required
            .dedup_by(|left, right| left.context == right.context && left.source == right.source);
        Ok(Policy::Known(required))
    }

    fn check_runs(
        &self,
        repository: &str,
        evaluation_sha: &str,
    ) -> Result<Vec<CheckRun>, ProviderError> {
        let (owner, repo) = Self::owner_repo(repository)?;
        let mut url = self.endpoint(&[
            "repos",
            owner,
            repo,
            "commits",
            evaluation_sha,
            "check-runs",
        ])?;
        url.query_pairs_mut().append_pair("per_page", "100");
        self.get_all_pages(url, Some("check_runs"))?
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
                let run_id = run.get("id").and_then(Value::as_u64).unwrap_or(0);
                let updated_at = run
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let stable = format!(
                    "{}:{}:{}:{}",
                    run_id,
                    name,
                    status,
                    conclusion.as_deref().unwrap_or("pending")
                );
                let details_fingerprint = Sha256::digest(stable.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
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
        let mut url =
            self.endpoint(&["repos", owner, repo, "commits", evaluation_sha, "statuses"])?;
        url.query_pairs_mut().append_pair("per_page", "100");
        self.get_all_pages(url, None)?
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
                    updated_at: status
                        .get("updated_at")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
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
    fn pagination_never_forwards_auth_to_a_foreign_link_origin() {
        let base = Url::parse("https://api.github.com/").unwrap();
        assert!(next_link("<https://attacker.invalid/page2>; rel=\"next\"", &base).is_err());
        assert_eq!(
            next_link(
                "<https://api.github.com/repos/org/repo?page=2>; rel=\"next\"",
                &base
            )
            .unwrap()
            .unwrap()
            .host_str(),
            Some("api.github.com")
        );
    }

    #[test]
    fn observes_exact_branch_pr_test_merge_policy_checks_and_statuses_read_only() {
        let server = MockServer::start();
        let branch = server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/anvil%2Ftask");
            then.status(200)
                .json_body(json!({"name":"anvil/task","commit":{"sha":"base"}}));
        });
        let pulls = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/pulls").query_param("head","org:anvil/task");
            then.status(200).json_body(json!([{"number":42,"state":"open","merged":false,"head":{"ref":"anvil/task","sha":"head-sha"},"base":{"ref":"main","repo":{"full_name":"org/repo"}},"merge_commit_sha":"test-merge-sha"}]));
        });
        let queue = server.mock(|when, then| {
            when.method(POST).path("/graphql");
            then.status(200)
                .json_body(json!({"data":{"repository":{"pullRequest":{"mergeQueueEntry":null}}}}));
        });
        let reviews = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/pulls/42/reviews");
            then.status(200).json_body(json!([
                {"id":11,"user":{"login":"reviewer"},"submitted_at":"2026-01-02T00:00:00Z","state":"COMMENTED"},
                {"id":10,"user":{"login":"reviewer"},"submitted_at":"2026-01-01T00:00:00Z","state":"CHANGES_REQUESTED"},
                {"id":12,"user":{"login":"reviewer-two"},"submitted_at":"2026-01-03T00:00:00Z","state":"CHANGES_REQUESTED"}
            ]));
        });
        let protection = server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/main/protection/required_status_checks");
            then.status(200)
                .json_body(json!({"contexts":["legacy"],"checks":[{"context":"lint","app_id":9}]}));
        });
        let rules = server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/rules/branches/main")
                .query_param("page", "1")
                .query_param("per_page", "100");
            then.status(200).json_body(json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CI","integration_id":9}]}}]))
                .header("link",format!("<{}>; rel=\"next\"",server.url("/repos/org/repo/rules/branches/main?per_page=100&page=2")));
        });
        let rules_second_page=server.mock(|when,then|{
            when.method(GET).path("/repos/org/repo/rules/branches/main").query_param("page","2").query_param("per_page","100");
            then.status(200).json_body(json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"security","integration_id":null}]}}]));
        });
        let checks = server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/commits/test-merge-sha/check-runs").query_param("per_page","100");
            then.status(200).json_body(json!({"check_runs":[{"id":5,"name":"CI","head_sha":"test-merge-sha","status":"completed","conclusion":"success"},{"id":6,"name":"lint","head_sha":"test-merge-sha","status":"completed","conclusion":"neutral"}]}));
        });
        let statuses = server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/commits/test-merge-sha/statuses")
                .query_param("per_page", "100");
            then.status(200)
                .json_body(json!([{"context":"legacy","sha":"test-merge-sha","state":"success"},{"context":"security","sha":"test-merge-sha","state":"success"}]));
        });
        let port = GitHubRestPort::new(&server.url("/"), "test-token").unwrap();
        let observed = GitHubCodeHost::new(port)
            .observe(&ObservationRequest {
                repository: "org/repo".into(),
                base_ref: "main".into(),
                work_branch: "anvil/task".into(),
                bound_pr_number: None,
            })
            .unwrap();
        assert_eq!(observed.pull_request.as_ref().unwrap().number, 42);
        assert_eq!(observed.pull_request.as_ref().unwrap().head_sha, "head-sha");
        assert_eq!(
            observed.pull_request.as_ref().unwrap().evaluation_sha,
            "test-merge-sha"
        );
        assert_eq!(
            observed.pull_request.as_ref().unwrap().evaluation_kind,
            EvaluationKind::TestMerge
        );
        assert!(observed.pull_request.as_ref().unwrap().review_state_known);
        assert!(observed.pull_request.as_ref().unwrap().changes_requested);
        assert_eq!(
            observed
                .required_checks
                .iter()
                .map(|c| c.context.as_str())
                .collect::<Vec<_>>(),
            ["CI", "legacy", "lint", "security"]
        );
        assert!(observed
            .required_checks
            .iter()
            .all(|c| c.state == anvil_reconcile::CheckState::Passing));
        for mock in [
            branch,
            pulls,
            queue,
            reviews,
            protection,
            rules,
            rules_second_page,
            checks,
            statuses,
        ] {
            mock.assert();
        }
    }

    #[test]
    fn inaccessible_effective_rules_return_unknown_not_green() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/anvil%2Ftask");
            then.status(200).json_body(json!({"name":"anvil/task"}));
        });
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/pulls");then.status(200).json_body(json!([{"number":42,"state":"open","head":{"ref":"anvil/task","sha":"h"},"base":{"ref":"main","repo":{"full_name":"org/repo"}}}]));});
        server.mock(|when, then| {
            when.method(POST).path("/graphql");
            then.status(200)
                .json_body(json!({"data":{"repository":{"pullRequest":{"mergeQueueEntry":null}}}}));
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/main/protection/required_status_checks");
            then.status(404);
        });
        server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/rules/branches/main");
            then.status(403);
        });
        let port = GitHubRestPort::new(&server.url("/"), "test-token").unwrap();
        let observed = GitHubCodeHost::new(port)
            .observe(&ObservationRequest {
                repository: "org/repo".into(),
                base_ref: "main".into(),
                work_branch: "anvil/task".into(),
                bound_pr_number: None,
            })
            .unwrap();
        assert!(!observed.required_policy_known);
        assert!(observed.required_checks.is_empty());
    }

    #[test]
    fn merge_queue_entry_uses_exact_merge_group_sha_for_required_checks() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/anvil%2Ftask");
            then.status(200).json_body(json!({"name":"anvil/task"}));
        });
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/pulls").query_param("head","org:anvil/task");then.status(200).json_body(json!([{"number":42,"state":"open","head":{"ref":"anvil/task","sha":"pr-head"},"base":{"ref":"main","repo":{"full_name":"org/repo"}},"merge_commit_sha":"test-merge"}]));});
        server.mock(|when,then|{when.method(POST).path("/graphql");then.status(200).json_body(json!({"data":{"repository":{"pullRequest":{"mergeQueueEntry":{"headCommit":{"oid":"merge-group-sha"}}}}}}));});
        server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/pulls/42/reviews");
            then.status(200).json_body(json!([]));
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/main/protection/required_status_checks");
            then.status(404);
        });
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/rules/branches/main");then.status(200).json_body(json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CI","integration_id":7}]}}]));});
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/commits/merge-group-sha/check-runs");then.status(200).json_body(json!({"check_runs":[{"id":8,"name":"CI","head_sha":"merge-group-sha","status":"completed","conclusion":"failure"}]}));});
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/commits/merge-group-sha/statuses");
            then.status(200).json_body(json!([]));
        });
        let observed = GitHubCodeHost::new(GitHubRestPort::new(&server.url("/"), "token").unwrap())
            .observe(&ObservationRequest {
                repository: "org/repo".into(),
                base_ref: "main".into(),
                work_branch: "anvil/task".into(),
                bound_pr_number: None,
            })
            .unwrap();
        let pr = observed.pull_request.unwrap();
        assert_eq!(pr.head_sha, "pr-head");
        assert_eq!(pr.evaluation_sha, "merge-group-sha");
        assert_eq!(pr.evaluation_kind, EvaluationKind::MergeGroup);
        assert!(observed.required_policy_known);
        assert_eq!(
            observed.required_checks[0].evaluation_sha,
            "merge-group-sha"
        );
        assert_eq!(
            observed.required_checks[0].state,
            anvil_reconcile::CheckState::Failing
        );
        assert!(pr.review_state_known);
    }

    #[test]
    fn inaccessible_review_state_is_explicitly_unknown() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/anvil%2Ftask");
            then.status(200).json_body(json!({"name":"anvil/task"}));
        });
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/pulls");then.status(200).json_body(json!([{"number":42,"state":"open","head":{"ref":"anvil/task","sha":"h"},"base":{"ref":"main","repo":{"full_name":"org/repo"}}}]));});
        server.mock(|when, then| {
            when.method(POST).path("/graphql");
            then.status(200)
                .json_body(json!({"data":{"repository":{"pullRequest":{"mergeQueueEntry":null}}}}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/repos/org/repo/pulls/42/reviews");
            then.status(403);
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/repos/org/repo/branches/main/protection/required_status_checks");
            then.status(404);
        });
        server.mock(|when,then|{when.method(GET).path("/repos/org/repo/rules/branches/main").query_param("page","1");then.status(200).json_body(json!([{"type":"required_status_checks","parameters":{"required_status_checks":[]}}]));});
        let observed = GitHubCodeHost::new(GitHubRestPort::new(&server.url("/"), "token").unwrap())
            .observe(&ObservationRequest {
                repository: "org/repo".into(),
                base_ref: "main".into(),
                work_branch: "anvil/task".into(),
                bound_pr_number: None,
            })
            .unwrap();
        assert!(!observed.pull_request.unwrap().review_state_known);
    }
}
