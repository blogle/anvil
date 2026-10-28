# GitHub App credential broker contract

`src/providers/github-app.ts` follows the incumbent broker in
`origin/main:crates/anvild/src/github.rs` at source baseline
`b55f9b0ecbf89309832c6dcdc9a615cbc4e15f8b`. The HTTP fixture exercises the
GitHub REST endpoint contract locally; no GitHub credentials or live API calls
are used by tests.

The broker signs a short-lived RS256 App JWT and requests an installation token
from `POST /app/installations/{installation_id}/access_tokens`, scoped to one
repository and one declared purpose:

| Purpose | Requested permissions |
|---|---|
| `git` | `contents:write`, `workflows:write` |
| `gh_read` | `actions:read`, `checks:read`, `contents:read`, `metadata:read`, `pull_requests:read` |
| `gh` | `actions:read`, `checks:read`, `contents:read`, `metadata:read`, `pull_requests:write` |

The response's effective permission map must be present and no broader than the
requested profile (GitHub's implicit `metadata:read` is accepted). A broader or
malformed response is rejected without returning the token. Cached tokens are
separated by normalized repository and purpose and refreshed inside a bounded
expiry margin. Errors retain safe code/status/request-ID diagnostics but do
not return upstream body text or credential material.

This checkpoint does not wire the broker into worker Git/`gh` processes. The
`GitHubDeliveryClient` adds repository branch, PR and check-run reads with the
`gh_read` profile, and governed PR create-or-observe with the `gh` profile.
After a lost PR-create acknowledgement it queries by owner/branch and only
records a discovered postcondition; absence remains ambiguous and is never
blindly replayed. `test/providers/github-delivery.test.ts` uses local fixtures
for repository-scoped auth, identity/revision mapping, check pagination, and
PR postcondition recovery. It does not implement branch push or commit-status
contexts. `GitHubWorldObserver` in `src/providers/github-world.ts` combines
Candidate, check, registered-PR and Mergify queue observations without defining
repository check policy. Worker/controller credential handoff and live GitHub
integration remain unverified.
