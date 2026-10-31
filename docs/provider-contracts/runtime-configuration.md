# Configured provider composition

`src/providers/runtime.ts` creates the local provider composition only when
`ANVIL_PROVIDER_MODE=configured`; the default is `unavailable` and performs no
provider network calls. Configured mode composes the documented OpenCode V2,
Agent Sandbox V1beta1, GitHub App/REST, and Mergify adapters behind
`ProviderComposition`.

Required runtime settings:

| Variable | Purpose |
|---|---|
| `ANVIL_PROVIDER_MODE` | Set to `configured` to opt in; otherwise provider mode is unavailable. Configured mode always uses Kubernetes Leases, with no local ownership fallback. |
| `ANVIL_KUBERNETES_API_URL`, `ANVIL_KUBERNETES_TOKEN_FILE`, `ANVIL_SANDBOX_NAMESPACE` | Kubernetes API endpoint, service-account token file, and isolated namespace for Sandbox CRs. |
| `ANVIL_SANDBOX_IMAGE_DIGEST`, `ANVIL_WORKSPACE_SIZE`, `ANVIL_PROFILE_PVC`, `ANVIL_NIX_PVC` | Runtime image digest and the existing Workspace/profile/shared-Nix PVC contracts. |
| `ANVIL_GITHUB_APP_ID`, `ANVIL_GITHUB_INSTALLATION_ID`, `ANVIL_GITHUB_PRIVATE_KEY_FILE` | Controller-held GitHub App credential broker inputs. The private key is read from a file and never passed to a worker. |
| `ANVIL_GIT_CAPABILITY_SECRET_FILE` | Controller-only HMAC key for short-lived Assignment/Session Git capabilities. Required in configured mode; never mounted into a worker. |
| `ANVIL_MERGIFY_TOKEN_FILE` | Separately held Mergify API bearer token. |
| `ANVIL_OPENCODE_URL_TEMPLATE` | HTTPS service URL template containing `{sandbox}` and `{namespace}` placeholders. |
| `ANVIL_OPENCODE_PASSWORD_FILE`, `ANVIL_OPENCODE_SECRET_NAME`, `ANVIL_OPENCODE_SECRET_KEY` | Required listener password (at least 32 characters) and matching Sandbox Secret reference; authenticates clients but does not isolate same-UID tools. |
| `ANVIL_GIT_CREDENTIAL_URL` | Stable HTTPS controller service URL ending in `/v1/git/credentials`, installed in the worker helper; loopback HTTP is permitted only for fixtures. |
| `ANVIL_OPENCODE_MODEL_PROVIDER`, `ANVIL_OPENCODE_MODEL_ID` | Explicit model selection for session instructions. |
| `ANVIL_CONTROLLER_ID` | Explicit deployment/process label (1–80 ASCII letters, digits, `_`, `.`, `:` or `-`). The daemon appends its own random incarnation UUID; read actual owner identity from Commission state. Reusing this label after restart does not impersonate the old holder. |
| `ANVIL_LEASE_NAMESPACE`, `ANVIL_LEASE_TOKEN_FILE` | Explicit control-plane Lease namespace and separate controller-only projected service-account token file. File is validated at startup and reread on every Lease API request. |

Optional values include `ANVIL_KUBERNETES_CA_FILE`, `ANVIL_GITHUB_API_URL`,
`ANVIL_MERGIFY_API_URL` and `ANVIL_OPENCODE_PORT`.
OpenCode HTTP is restricted to loopback fixture hosts; configured
non-loopback OpenCode endpoints must use HTTPS.

`ANVIL_LEASE_API_URL` optionally overrides the Lease endpoint; otherwise it uses
`ANVIL_KUBERNETES_API_URL`. Lease transport requires credential-free HTTPS with
explicit `ANVIL_KUBERNETES_CA_FILE`; HTTP is accepted only for loopback fixtures.
No kubeconfig, automatic in-cluster credential discovery or insecure TLS fallback
is used. Optional `ANVIL_LEASE_DURATION_SECONDS` defaults to 30 (10–300),
`ANVIL_LEASE_TIMEOUT_MS` to 2000, and `ANVIL_LEASE_MAX_CLOCK_SKEW_MS` to 2000
(minimum 1000). Duration must exceed twice the skew plus twice the timeout.
The safe grant ends before nominal expiry by twice the skew plus the timeout.
Configure reconciliation below that safe window; renewal occurs on every
authority check, not via an independent background ownership controller.

Per-Commission Lease names are `anvil-commission-` plus the first 40 SHA-256 hex
characters of the exact Commission ID. The managed contract records the original
ID and contract version in annotations, `holderIdentity`, `leaseTransitions`,
duration, acquire/renew times and opaque resourceVersion. Each CAS includes a
fresh confirmation nonce; a stale 2xx body cannot confirm a new request even when
timestamps coincide. A grant requires fresh GET plus POST/PUT CAS and validation
of returned namespace/name/UID, owner, epoch, nonce and validity. Conflicts,
permission denial, transport/body errors and clock violations return no grant.
Acquire/renew instants are compared at microsecond precision, accepting equivalent
Kubernetes MicroTime fractional formatting without accepting a changed instant.

`leaseTransitions` is the succession epoch (positive Kubernetes int32), bounded
below by the existing durable Commission owner epoch. Acquisition increments it;
renewal preserves it; release clears the holder with CAS and retains the resource
and epoch. A process-local acquisition receipt prevents treating an observed copy
of one's holder string as ownership proof. Restart creates a new incarnation and
acquires a new epoch after release or conservatively observed expiry. A foreign
unchanged record must be observed for its full duration plus twice the skew on a
monotonic clock; foreign timestamps never accelerate takeover. Server Date skew,
future renewals and local wall/monotonic discontinuities fail closed. A local
clock discontinuity requires process restart.

Every controller for a Commission must use the same authoritative durable SQLite
journal, Lease namespace and API. Missing Lease history for an already-owned
Commission, epoch regression/exhaustion, database rollback/clone or unreviewed
namespace migration requires explicit recovery. There is no automatic epoch reset
or Lease deletion. Kubernetes resourceVersion is CAS evidence, not remote fencing.
Controller-only RBAC and the missing Workspace isolation boundary are described
in [operations](../operations.md#kubernetes-lease-authority).

The runtime computes a stable work-branch name from Commission identity. The
local `GitHubWorldObserver` observes branch SHA, required contexts from branch
rulesets/classic branch protection, SHA-bound Check Runs and commit statuses,
registered PR, and Mergify queue. Missing or unavailable required-check policy
and missing contexts cannot become passing; neutral/skipped runs are unknown.
Merge-queue health remains separate from source-PR CI. Integration creates or
finds a PR for the work branch and re-observes after ambiguous acknowledgements.

Known scope limits: Lease arbitration is locally protocol-tested, not live
Kubernetes, HA storage or remote fencing acceptance. The default unavailable
provider mode retains single-process local authority for development only.
`/v1/git/credentials` and
`src/providers/git-credentials.ts` authenticate bounded Assignment/Attempt,
Session, Workspace, owner-epoch, repository, ref and Lease claims and mint only
the existing `contents:write` profile. Configured bootstrap installs the capability
and image-bundled helper through pinned OpenCode shell/fs APIs; local real-Git
publication is tested, while deployed Sandbox startup remains blocked. The actual
same-UID worker can recover the OpenCode API password; `workerAccessGate` fails.
See [access and receiver requirements](../operations.md#opencode-api-access-boundary).
A leaked installation token is repository-wide and can push another
unprotected ref until expiry; only existing branch rules protect configured
branches. Verification observes CI but does not initiate a run. OpenCode Session-create lost acknowledgements stay
unknown, and GitHub/Mergify/Sandbox credentials have not been validated against
live services. Never enable this mode against a cluster without the separately
authorized deployment workflow and independently reviewed isolation. The current
campaign's [external acceptance gate](../plans/active/autonomous-first-slice.md#live-acceptance)
records its FS-15 prerequisites and authorization status; stable procedures are in
[operations](../operations.md).
