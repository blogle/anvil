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

### Provider credentials and profile OAuth

Provider credential management is operator-gated: every route below requires
`Authorization: Bearer <operator-token>`. The supported management surface is
`GET /v1/provider-credentials` (metadata only),
`PUT /v1/provider-credentials/{provider}` (API-key JSON body `{"key":"…"}`),
`GET /v1/provider-credentials/catalog`, and
`GET /v1/provider-credentials/{provider}/methods`. OAuth uses
`POST /v1/provider-credentials/{provider}/oauth` to start a selected method,
`GET /v1/provider-credentials/{provider}/oauth/{login_id}` to poll its status,
and `POST /v1/provider-credentials/{provider}/oauth/{login_id}/complete` with
`{"code":"…"}` when that method requires code completion. The catalog exposes
only the `key` and `oauth` credential kinds; it is not a promise that all
OpenCode providers or authentication methods are available or usable.

OpenCode v2 profile OAuth is performed against the authenticated profile service:
Anvil starts and observes the OAuth attempt through `/api/integration`, then
exports credentials through `/api/credential`. The secret credential payload is
stored as a new generation in the controller database, sealed with AES-256-GCM;
it is not returned to or stored in the browser. Browser Settings may initiate or
display the operator flow, but must not handle the exported secret payload.
The operator CLI also supports these management operations. The OpenCode profile
must keep `XDG_DATA_HOME` on storage anchored to the profile PVC, so its SQLite
database (including profile credential state) survives profile Pod restarts. No
Kubernetes worker, including a default or uncredentialed worker, receives or mounts
the profile PVC. Every worker has private OpenCode config and XDG data; credentials
are delivered only by the selected init-container import into that worker's private
SQLite database.

Enable provider credential management only by provisioning both daemon secrets:
`ANVIL_PROVIDER_OPERATOR_TOKEN` (at least 32 characters) and
`ANVIL_PROVIDER_ENCRYPTION_KEY` (64 hexadecimal characters, 32 random bytes).
They must be provided together. The encryption key must remain secret and stable
to decrypt existing records. Provision and rotate these through dotfiles' Secret
workflow; never commit or put secret values in manifests, docs, URLs or logs.
Key or OAuth credential updates create a new generation. These are operator
credentials, not worker access.

During worker provisioning, Anvil selects one provider credential generation and
issues a session/provider/generation-bound, one-use bootstrap capability.
`GET /v1/sessions/{id}/credentials/provider` is a private init-only endpoint: the
capability is removed from the Sandbox's regular container environment and passed
only to the Workspace init container. Init imports that selected key or OAuth
credential into the worker's private OpenCode SQLite database. If controller
credential management is active and an explicitly selected model has no matching
stored provider credential, execution fails closed. The capability does not grant
the worker general operator API access. Bootstrap is not fully restart-safe:
redemption consumes the token before the import completes. No supported automatic
recovery or public capability-reissue endpoint exists; recovery requires operator
remediation and a new Session (tracked by ANVIL-72), not a reissue command on an
existing Session.

OpenAI's `chatgpt-headless` device-code method is the supported headless OAuth
flow. Browser callback-based modes may not work when the profile is remote or
otherwise cannot receive the callback. This is an implementation contract, not
evidence that real OpenAI consent succeeds, refresh tokens remain valid for any
particular duration, or a worker can execute billed requests. Tests are synthetic
and APIs have been source-probed only; no real provider credentials have been
supplied, and no billed worker execution has been established. Do not interpret
profile OAuth completion or a worker readiness probe as proof of working worker
provider authentication.

An OpenCode Go key can coexist as a distinct `opencode-go` provider credential;
it is not a substitute or alias for OpenAI OAuth. If explicitly configured via
`ANVIL_OPENCODE_GO_SECRET`, naming a namespace-local Secret with key `go-key`,
only the Workspace init container mounts it and imports it into that worker's
private SQLite database. The serving container does not mount either that Secret
or the shared profile PVC. This contract declares a required Secret
**reference**, not its provisioning or contents.

Each Attempt selects one model provider; provider selection is Attempt-scoped,
not a Commission-wide mechanism for switching providers. The existing retry
fence remains: the scheduler does not permit a second Commission Workspace after
the prior Session has been bound, so selecting another provider in a later
Attempt is not yet an implemented provider-switch execution retry.

Environment namespaces, addrspace manifests, ingress domains/certificates, storage
classes, secret provisioning, rollout/cleanup and production protection belong in
**dotfiles**. Project specifications describe what deployment must provide; dotfiles
describes how a particular environment provides it. In particular, all
SealedSecrets for an environment are authored and provisioned from dotfiles,
never from this repository. Draft an ExecPlan under
`docs/plans/active/` only after these two specifications are agreed.
