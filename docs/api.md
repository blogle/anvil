# API and Runtime Contract

## Operator API

`anvild` is the authoritative HTTP API used by `anvilctl`. Provider state is
normalized and never includes credential contents:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/providers` | List providers, authentication status, available auth methods, and API-key capability |
| `POST` | `/v1/providers/{provider}/login` | Begin an OpenCode OAuth or API-key attempt |
| `POST` | `/v1/providers/{provider}/login/{login_id}/complete` | Complete the in-memory login attempt |
| `GET` | `/v1/opencode/config` | Read the shared profile OpenCode configuration |

Session controller routes are:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/sessions` | Create a session and dispatch its initial prompt |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/{id}` | Read durable session metadata and binding state |
| `POST` | `/v1/sessions/{id}/messages` | Send steering to the current OpenCode session |
| `GET` | `/v1/sessions/{id}/messages` | Read OpenCode messages |
| `GET` | `/v1/sessions/{id}/status` | Read environment, execution, work, and binding state |
| `GET` | `/v1/sessions/{id}/activity` | Read the normalized dashboard/activity model |
| `GET` | `/v1/sessions/{id}/diff` | Read the repository diff |
| `GET` | `/v1/sessions/{id}/previews/{port}` | Resolve a preview URL |
| `POST` | `/v1/sessions/{id}/abort` | Abort the current OpenCode turn |
| `POST` | `/v1/sessions/{id}/suspend` | Suspend the Sandbox |
| `POST` | `/v1/sessions/{id}/resume` | Resume and reconcile the Sandbox |
| `POST` | `/v1/sessions/{id}/rebind` | Explicitly create a replacement OpenCode binding |
| `POST` | `/v1/sessions/{id}/complete` | Controller acceptance into `completed` |
| `DELETE` | `/v1/sessions/{id}` | Delete the session and workspace |

Provider login is a relay to the singleton profile OpenCode server. OpenCode
1.18.30 supplies `GET /provider`, `GET /provider/auth`,
`POST /provider/{id}/oauth/authorize`, `POST /provider/{id}/oauth/callback`,
and `PUT /auth/{providerID}` for API credentials. Anvil does not implement
provider OAuth protocols or return tokens. API keys are accepted only for
providers advertising an environment variable and are forwarded in memory to
OpenCode without being logged or persisted by Anvil. Pending login IDs live only in `anvild` memory, so
an `anvild` restart requires an in-progress login to be restarted; completed
credentials remain on the profile PVC.

## Session work state

Session responses expose independent `environment_state`, `execution_state`, and
`work_state` fields. Environment state is derived from Sandbox lifecycle,
execution state from OpenCode status, and work state is durable Anvil metadata.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions/{id}/report-context` | Return the current worker run ID |
| `POST` | `/v1/sessions/{id}/report` | Report `ready_for_review` or `awaiting_input` |
| `POST` | `/v1/sessions/{id}/complete` | Controller acceptance into `completed` |
| `POST` | `/v1/sessions/{id}/rebind` | Explicitly create a replacement OpenCode session |

Reports require `Authorization: Bearer <session capability>` and include the
current `run_id`. Summaries are trimmed and limited to 500 characters. Run and
work metadata are stored with the Sandbox annotations, so they survive service
restarts and Sandbox suspension.

New Sandboxes mount their workspace PVC at `/home/anvil`, check out the
repository under `/home/anvil/workspace/<project>`, and store OpenCode's native
conversation database and XDG data/state paths there. The controller records
the runtime layout as `v2`; legacy immutable Sandboxes retain their original
layout and are handled by automatic replacement recovery if their ephemeral
OpenCode state is gone.

Session reads, resume, and message/proxy operations reconcile the durable
`opencode_session_id` against the running server. An existing exact ID is
always retained. A definitive 404 causes Anvil to create one replacement under
a per-session lock, record the old and new IDs plus lost continuity in
annotations and append-only history, and continue transparently. Network,
startup, and other health failures do not trigger replacement. The API still
exposes `session_binding_state` (`pending`, `recovering`, `available`, or
`rebound`) and continuity fields for operators, while the explicit `rebind`
route remains an exceptional operator escape hatch.

When a model is selected at session creation, Anvil resolves and persists its
qualified provider/model ID. Every generated prompt, including a manual rebind
prompt and prompts sent after automatic recovery, uses that exact resolved
model; there is no silent model fallback.

The MCP server projects these controller routes as structured JSON tool
results. Mutations include `accepted`, `session_id`, the authoritative result,
and a current status projection where the session still exists. HTTP errors are
returned as structured MCP error data containing the HTTP status and Anvil's
`error.code`/`error.message` object rather than an opaque JSON string.

## CLI boundary

`anvilctl` uses `ANVIL_URL` or `--server` and talks to these API routes over
HTTP. `just` remains a development/build/deployment workflow and does not
provide provider-login or session-administration commands.

Manual diagnostics use `anvilctl session report <session> <disposition>` with
`ANVIL_SESSION_CREDENTIAL` (or `--capability`); controller acceptance uses
`anvilctl session complete <session>`.

Anvil uses the Agent Sandbox `agents.x-k8s.io/v1beta1` `Sandbox` resource. The
`anvild` process is configured with `ANVIL_NAMESPACE` and is the sole component
allowed to create, observe, update, patch, or delete those resources in `anvil`.

The base runtime ConfigMap also supplies the internal endpoints:

| Variable | Value | Consumer |
| --- | --- | --- |
| `ANVIL_BIND_PORT` | `8080` | anvild |
| `ANVIL_SANDBOX_ROUTER_URL` | Agent Sandbox Router service DNS | anvild/router |
| `ANVIL_PROFILE_OPENCODE_URL` | profile OpenCode service DNS | anvild |
| `ANVIL_PROFILE_PVC` | `anvil-opencode-profile` | anvild/sandboxes |
| `ANVIL_PREVIEW_DOMAIN` | preview wildcard domain | anvild |
| `RUST_LOG` | `info` | all services |

The Deployment image contract is the public GHCR images
`ghcr.io/blogle/anvil` for Anvil services and
`ghcr.io/blogle/anvil-sandbox` for OpenCode workers/profile. The base overlay
uses the `main` tags for development; production overlays should pin immutable
SHA tags. No secret, token, or kubeconfig belongs in the ConfigMap.

Ingress accepts the configured preview wildcard; routing and authentication at
that boundary are the router/Traefik responsibility.

The `POST /v1/sessions/:id/credentials/github` route accepts an optional JSON
body with a server-defined `purpose`: `git`, `gh_read`, or `gh`. `git` requests
Contents write access for HTTPS Git; `gh_read` requests only read permissions
for supported inspection commands; and `gh` adds pull-request write access for
the sandbox `gh` wrapper. Clients cannot supply arbitrary GitHub permissions.
The GitHub App installation must grant Pull requests: write before `gh` can
use that profile; otherwise GitHub rejects the token request with HTTP 422.
An omitted body deliberately selects the legacy pre-purpose profile for
persistent old sandbox helpers during rollout. The route continues to require
the session capability bound to the requested session and repository.
