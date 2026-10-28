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

This checkpoint implements token issuance only. It is not yet wired into worker
Git/`gh` processes or a provider composition. `src/providers/github-delivery.ts`
adds read-only repository branch, pull-request, and check-run observations over
the broker's `gh_read` token. `test/providers/github-delivery.test.ts` uses a
local HTTP fixture to prove repository-scoped auth, identity/revision mapping,
incomplete check pagination, and unavailable/not-found distinctions. It does
not yet implement branch creation/push, pull-request creation, commit-status
contexts, Mergify, or session-capability endpoints. Worker/controller
credential handoff and live GitHub integration remain unverified.
