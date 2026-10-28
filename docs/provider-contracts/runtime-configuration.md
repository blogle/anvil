# Configured provider composition

`src/providers/runtime.ts` creates the local provider composition only when
`ANVIL_PROVIDER_MODE=configured`; the default is `unavailable` and performs no
provider network calls. Configured mode composes the documented OpenCode V2,
Agent Sandbox V1beta1, GitHub App/REST, and Mergify adapters behind
`ProviderComposition`.

Required runtime settings:

| Variable | Purpose |
|---|---|
| `ANVIL_PROVIDER_MODE` | Set to `configured` to opt in; otherwise provider mode is unavailable. |
| `ANVIL_KUBERNETES_API_URL`, `ANVIL_KUBERNETES_TOKEN_FILE`, `ANVIL_SANDBOX_NAMESPACE` | Kubernetes API endpoint, service-account token file, and isolated namespace for Sandbox CRs. |
| `ANVIL_SANDBOX_IMAGE_DIGEST`, `ANVIL_WORKSPACE_SIZE`, `ANVIL_PROFILE_PVC`, `ANVIL_NIX_PVC` | Runtime image digest and the existing Workspace/profile/shared-Nix PVC contracts. |
| `ANVIL_GITHUB_APP_ID`, `ANVIL_GITHUB_INSTALLATION_ID`, `ANVIL_GITHUB_PRIVATE_KEY_FILE` | Controller-held GitHub App credential broker inputs. The private key is read from a file and never passed to a worker. |
| `ANVIL_MERGIFY_TOKEN_FILE` | Separately held Mergify API bearer token. |
| `ANVIL_OPENCODE_URL_TEMPLATE` | HTTPS service URL template containing `{sandbox}` and `{namespace}` placeholders. |
| `ANVIL_OPENCODE_MODEL_PROVIDER`, `ANVIL_OPENCODE_MODEL_ID` | Explicit model selection for session instructions. |

Optional values include `ANVIL_KUBERNETES_CA_FILE`, `ANVIL_GITHUB_API_URL`,
`ANVIL_MERGIFY_API_URL`, `ANVIL_OPENCODE_PORT`, `ANVIL_OPENCODE_PASSWORD_FILE`,
and `ANVIL_OPENCODE_SECRET_NAME`/`ANVIL_OPENCODE_SECRET_KEY` (required together
with the password file so the Sandbox receives a Secret reference, not the
value). OpenCode HTTP is restricted to loopback fixture hosts; configured
non-loopback OpenCode endpoints must use HTTPS.

The runtime computes a stable work-branch name from Commission identity. The
local `GitHubWorldObserver` observes branch SHA, check runs, registered PR, and
Mergify queue. Integration creates or finds a PR for the work branch and
re-observes after ambiguous acknowledgements. Check-run observations are
conservative when pagination is incomplete or no checks exist.

Known scope limits: `main.ts` still uses a single-process local Lease adapter,
the composition has no runtime Lease fencing, Git push is performed by the
worker rather than an adapter, commit-status contexts are not read, verification
does not initiate a CI run, OpenCode Session-create lost acknowledgements stay
unknown, and GitHub/Mergify/Sandbox credentials have not been validated against
live services. Never enable this mode against a cluster without the separately
authorized FS-15 workflow and independently reviewed isolation.
