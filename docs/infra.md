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

Environment namespaces, addrspace manifests, ingress domains/certificates, storage
classes, secret provisioning, rollout/cleanup and production protection belong in
**dotfiles**. Project specifications describe what deployment must provide; dotfiles
describes how a particular environment provides it. Draft an ExecPlan under
`docs/plans/active/` only after these two specifications are agreed.
