# API and Runtime Contract

## Operator API

`anvild` is the authoritative HTTP API used by `anvilctl`. Provider state is
normalized and never includes credential contents:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/providers` | List providers, authentication status, and available auth methods |
| `POST` | `/v1/providers/{provider}/login` | Begin an OpenCode OAuth attempt |
| `POST` | `/v1/providers/{provider}/login/{login_id}/complete` | Complete the in-memory login attempt |
| `GET` | `/v1/opencode/config` | Read the shared profile OpenCode configuration |

Provider login is a relay to the singleton profile OpenCode server. OpenCode
1.18.30 supplies `GET /provider`, `GET /provider/auth`,
`POST /provider/{id}/oauth/authorize`, and
`POST /provider/{id}/oauth/callback`. Anvil does not implement provider OAuth
protocols or return tokens. Pending login IDs live only in `anvild` memory, so
an `anvild` restart requires an in-progress login to be restarted; completed
credentials remain on the profile PVC.

## CLI boundary

`anvilctl` uses `ANVIL_URL` or `--server` and talks to these API routes over
HTTP. `just` remains a development/build/deployment workflow and does not
provide provider-login or session-administration commands.

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

The Deployment image name is the local development contract `anvil:dev` for
Anvil services and `anvil-sandbox:dev` for OpenCode workers/profile. Every container uses
`imagePullPolicy: Never`; the selected cluster nodes must already contain these
exact images. No secret, token, or kubeconfig belongs in the ConfigMap.

Ingress accepts the configured preview wildcard; routing and authentication at
that boundary are the router/Traefik responsibility.
