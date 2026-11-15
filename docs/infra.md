# Components and infrastructure

The [controller spec](spec.md) defines behavior. These components provide its runtime,
storage, provider and operator interfaces.

| Component | Responsibility and interface |
| --- | --- |
| Daemon (`anvild`) | Durable controller state, harness/watchdog, provider observations and authorized commands. HTTP is the shared authority for clients; state lives on persistent storage. |
| Operator surfaces | UI, `anvilctl` and MCP expose work, evidence and interventions. Preserve interactive preview/steering while introducing Campaign/Commission views. PR #124's Ledger mockups are the UI reference. |
| OpenCode worker | Executes instructions in a persistent per-work Workspace; retains checkout, branch, Session state and preview servers. Existing checkout/bootstrap and browser tooling are assets to retain or deliberately adapt. |
| Agent Sandbox | Upstream CRDs/controller own Sandbox Pod, Service and Workspace PVC lifecycle. Its Sandbox Router is a platform dependency, distinct from Anvil's preview proxy. |
| Anvil router | Maps preview hosts to Sandbox identity/port and proxies HTTP/WebSocket traffic through the upstream Sandbox Router. Environment ingress supplies DNS, TLS and access middleware. |
| OpenCode profile | Existing singleton service and profile PVC supply configuration/provider authentication. Workers retain private conversation/project state; shared profile credential-refresh behavior needs characterization. |
| Shared Nix | Singleton daemon owns persistent store/database writes and build users. Image bootstrap seeds runtime closure/DB and retains warm outputs/GC roots. UID-1000 workers use read-only store/socket mounts as untrusted build clients. Existing RWO placement and no-Pod-`fsGroup` constraints matter. |
| GitHub credential broker | Daemon-held App identity issues scoped, short-lived credentials through worker helpers and signed capabilities. App keys/signing secrets stay controller-side; provider tokens remain subject to their actual provider scope and expiry. |
| GitHub and Mergify | Authoritative repository/PR, checks, approval, queue and merge observations. Repository labels/rules govern review versus automatic integration; Anvil does not implement reviewer identity policy. |

## Incremental Campaign execution boundary

Campaign submission validates the entire Commission contract and dependency graph
in `anvil-core`, then commits Campaign/Commission identities and a scoped
idempotency receipt in one daemon SQLite transaction. Each Commission currently
uses its existing Task ID as an internal execution adapter: the legacy scheduler
is the sole admission/execution writer, and an explicit version-checked start
gate precedes admission. An ordinary worker turn does not terminate its strategy
Attempt. HTTP and MCP share the daemon's application operations; immutable
Campaign membership uses a bounded keyset page cursor, separate from the
controller's change stream. Historical Task readers and execution paths remain
until client migration and safe retirement; they are not a second public work
model to expand. A submitted but unobserved worker prompt is recovery-required,
not automatically replayed.

## Worker context and reporting interface

The worker environment installs the Anvil reporting skill where OpenCode discovers
Workspace skills. It documents progress, obligation evidence, artifacts and blocker
reporting; the controller supplies current work identities, requirements and facts
in each instruction. Skill instructions do not confer amendment or approval authority.

A reporting-tool experiment uses OpenCode v2 plugin tool registration and execution
context to attribute calls to Session/message/tool-call identities. Anvil resolves
their Commission/Attempt/instruction binding and validates obligation version and
Candidate; identity fields supplied by the model are not authoritative. Submission
returns a durable receipt or an explicit error, with deduplication across retries.
The comparison path ingests structured completed responses with equivalent bindings.
Neither path silently accepts a malformed, stale or foreign report. Controller outage,
lost acknowledgement, restart, omitted report and duplicate call are experiment cases.
The exact schema/transport remains to be selected from actual pinned-runtime results.

OpenCode context/prompt hooks can supply reporting guidance and event subscriptions
can wake Anvil. Only Anvil's serialized harness admits autonomous prompts. Reporting
guidance survives context refresh; replacement Sessions receive the same installed
skill and a reconstructed context packet. Compare retained and fresh-per-prompt
autonomous Sessions without changing the Attempt strategy or Workspace to isolate
context-policy effects. Interactive Sessions preserve conversational continuity.

Relevant research supports compact context and durable handoffs, not a universal
reset threshold: [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
and [model-dependent harness simplification](https://www.anthropic.com/research/harness-design-long-running-apps).
Failure reflection/classification using an LLM is a later experiment, inspired by
[Reflexion](https://arxiv.org/abs/2303.11366); it is not the initial controller policy.

## Artifact and resource contract

Declarative Nix builds supply service binaries/UI and Anvil, worker and shared-Nix
images. Deployment binds reviewed immutable image identities, configuration and
Secret references. Required resources include daemon/MCP/router/profile/Nix services
and workloads, controller-state/profile/shared-Nix claims, generated Workspace claims,
the Sandbox API dependency, scoped ServiceAccounts/RBAC, probes and network boundaries.
Only components that need Kubernetes authority receive it; preview and MCP services
do not need Kubernetes credentials. The daemon is the broker authority, not the worker.

Document credential *roles and consumers* here: GitHub App ID/installation/private
key and capability signing secret for the broker; OpenCode/model credentials for
the profile/runtime; operator authentication and any provider credentials required
by the agreed integration. Never document secret values. Exact Secret names/keys,
mounts and adapters should follow the actual implementation of each slice.

### Provider API-key credentials

Provider API keys are operator-managed through `GET /v1/provider-credentials` and
`PUT /v1/provider-credentials/{provider}` (JSON body `{"key":"…"}`). Both
require `Authorization: Bearer <operator-token>`. The API returns credential
metadata, not key material. The same operator boundary is exposed by `anvilctl`
provider-credentials list/set and the web Settings page; the CLI reads
`ANVIL_PROVIDER_OPERATOR_TOKEN` and prompts for the key, while Settings takes the
token and key in password fields and keeps them in page memory only. This is
operator access, not worker access.

Enable the API only by provisioning both daemon secrets:
`ANVIL_PROVIDER_OPERATOR_TOKEN` (at least 32 characters) and
`ANVIL_PROVIDER_ENCRYPTION_KEY` (64 hexadecimal characters, 32 random bytes).
They must be provided together; the encryption key seals keys with AES-256-GCM
before controller-store persistence and must remain secret and stable to decrypt
existing records. Provision and rotate these through dotfiles' Secret workflow;
never commit or put secret values in manifests, docs, URLs or logs. A new
generation is stored on key update.

During worker provisioning, Anvil issues a session/provider/generation-bound,
one-use bootstrap capability. `GET /v1/sessions/{id}/credentials/provider` is a
private init-only endpoint: the capability is removed from the Sandbox's regular
container environment and passed only to the Workspace init container, which
imports the API key into that Workspace's private OpenCode SQLite database. It
does not grant the worker general operator API access. Bootstrap is not fully
restart-safe: redemption consumes the token before the import completes, so if
import fails after redemption, an operator must issue a new capability; automatic
recovery is not available yet.

The `ANVIL_OPENCODE_GO_SECRET` / `go-key` injection below is a legacy, explicit
opt-in path, not the primary provider-key integration. Worker OAuth credential
handoff is not supported; do not treat profile OAuth state or successful worker
readiness as evidence of worker provider authentication.

An isolated OpenCode Go worker may opt into `ANVIL_OPENCODE_GO_SECRET`, naming a
namespace-local Secret with key `go-key`. Only its workspace init container
mounts the key; it imports the credential into OpenCode's private SQLite database
on that worker's persistent Workspace before starting the server. The serving
container does not mount either that Secret or the shared profile claim. Without
the opt-in, existing profile-based sandbox behavior is unchanged. This contract
declares a required Secret **reference**, not its provisioning or its contents.
The pinned OpenCode V2 runtime stores live credentials in SQLite rather than the
legacy `auth.json`; ChatGPT OAuth/profile-to-worker credential continuity is not
established by the Go-key path. Do not interpret an OpenCode readiness probe as
proof that provider authentication works.

Environment namespaces, addrspace manifests, ingress domains/certificates, storage
classes, secret provisioning, rollout/cleanup and production protection belong in
**dotfiles**. Project specifications describe what deployment must provide; dotfiles
describes how a particular environment provides it. In particular, all
SealedSecrets for an environment are authored and provisioned from dotfiles,
never from this repository. Draft an ExecPlan under
`docs/plans/active/` only after these two specifications are agreed.
