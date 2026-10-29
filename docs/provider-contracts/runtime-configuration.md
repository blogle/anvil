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
| `ANVIL_GIT_CAPABILITY_SECRET_FILE` | Controller-only HMAC key for short-lived Assignment/Session Git capabilities. Required in configured mode; never mounted into a worker. |
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
local `GitHubWorldObserver` observes branch SHA, required contexts from branch
rulesets/classic branch protection, SHA-bound Check Runs and commit statuses,
registered PR, and Mergify queue. Missing or unavailable required-check policy
and missing contexts cannot become passing; neutral/skipped runs are unknown.
Merge-queue health remains separate from source-PR CI. Integration creates or
finds a PR for the work branch and re-observes after ambiguous acknowledgements.

Known scope limits: `main.ts` still uses a single-process local Lease adapter,
the composition has no cross-process Lease fencing. `/v1/git/credentials` and
`src/providers/git-credentials.ts` authenticate bounded Assignment/Attempt,
Session, Workspace, owner-epoch, repository, ref and Lease claims and mint only
the existing `contents:write` profile. The actual Agent Sandbox does not yet
receive a capability file or include the helper in its image; a real push is not
wired. A leaked installation token is repository-wide and can push another
unprotected ref until expiry; only existing branch rules protect configured
branches. Verification observes CI but does not initiate a run. OpenCode Session-create lost acknowledgements stay
unknown, and GitHub/Mergify/Sandbox credentials have not been validated against
live services. Never enable this mode against a cluster without the separately
authorized FS-15 workflow and independently reviewed isolation.
