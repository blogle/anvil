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
| `git` | `contents:write` |
| `gh_read` | `administration:read`, `actions:read`, `checks:read`, `contents:read`, `metadata:read`, `pull_requests:read`, `statuses:read` |
| `gh` | `actions:read`, `checks:read`, `contents:read`, `metadata:read`, `pull_requests:write` |

The response's effective permission map must be present and no broader than the
requested profile (GitHub's implicit `metadata:read` is accepted). A broader or
malformed response is rejected without returning the token. Cached tokens are
separated by normalized repository and purpose and refreshed inside a bounded
expiry margin. Errors retain safe code/status/request-ID diagnostics but do
not return upstream body text or credential material.

The `git` profile no longer requests `workflows:write`: content pushes do not
need workflow-definition authority. Broker tests assert repository isolation
and this contents-only profile. `src/providers/git-credentials.ts` now adds a
short-lived signed capability, a live Assignment/Session/Workspace/Lease
authority check, the `/v1/git/credentials` endpoint and a Bun Git credential
helper. The helper returns the existing broker's repository-scoped token via
Git's credential protocol; the raw token is necessarily available to that Git
worker process until its provider expiry. It is not stored in controller
Commission/Operation state or remote URLs.

This endpoint/helper subset is process-tested through `git credential fill`.
It is not yet bootstrapped into the Agent Sandbox: no signed capability file or
helper command is installed in its Workspace. It does not perform an actual Git
push. `contents:write` is repository-scoped but not ref-scoped; the signed
capability binds the requested target ref at issuance, while a worker possessing
the resulting token can still attempt another unprotected ref. Protected-branch
rules apply only to configured protected refs; this code does not claim strict
branch confinement. A future additional policy decision is needed for any
stronger receive-pack proxy. The
`GitHubDeliveryClient` adds repository branch, PR and check-run reads with the
`gh_read` profile, and governed PR create-or-observe with the `gh` profile.
After a lost PR-create acknowledgement it queries by owner/branch and only
records a discovered postcondition; absence remains ambiguous and is never
blindly replayed. `test/providers/github-delivery.test.ts` uses local fixtures
for repository-scoped auth, identity/revision mapping, check pagination, and
PR postcondition recovery. It does not implement branch push. `GitHubWorldObserver`
resolves required contexts from branch rules and classic branch protection,
then matches Check Runs or legacy commit statuses to the exact Candidate SHA.
No required profile, missing context, incomplete evidence, skipped/neutral
check, or unavailable policy can become green. Mergify queue state remains
separate from source-PR CI. Actual Sandbox capability bootstrap, ordinary Git
push and live GitHub integration remain unverified.
