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

OpenCode conversation data is stored in the Sandbox workspace PVC under the
native OpenCode XDG data/state paths. Session reads reconcile the durable
`opencode_session_id` against the running server and expose
`session_binding_state` (`pending`, `recovering`, `available`, `missing`, or
`rebound`) plus continuity and recovery error fields. A missing binding is not
silently replaced. Use `rebind` only as an explicit fallback; it records lost
conversation continuity and optionally accepts a recovery prompt.

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
