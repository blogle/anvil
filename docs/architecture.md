# Anvil — Architecture

This document is the source of truth for *how Anvil is built*: packages, modules,
dependency rules, type-system invariants, and the decision log. Product behavior
lives in [spec.md](spec.md); each fact has one home and the other cross-references,
never restates.

## 1. Packages

One Cargo workspace; five packages, each earning its existence by build cost,
distribution surface, or contract identity:

| Package | Kind | Why it exists |
| --- | --- | --- |
| `anvil-api` | lib | Wire types and the contract of record: campaign/commission specs, state enums, event types, API payloads. One home shared by every binary. |
| `anvil` | bin | Operator CLI. Tiny dependency tree (clap, reqwest, serde, a table crate) so laptop installs never compile the daemon's world. |
| `anvild` | bin | The control plane. All heavy dependencies (axum, sqlx, kube-rs, podman client, OTel) live only here. |
| `anvilctl` | bin | Sandbox signal CLI (`done`, `attention`). Near-zero deps; ships inside the sandbox image. |
| `anvil-router` | bin | Preview proxy. Separate process by design (pages stay routable across daemon restarts). |

**MUST:** the client CLI never gains a dependency on any package that pulls the
daemon's dependency tree; the wire contract exists only once, in `anvil-api`.

## 2. Modules inside `anvild`

Seven modules, organized by cohesive responsibility:

```
api       → HTTP/SSE/MCP mounts: operator, operator-MCP, sandbox-facing (anvilctl)
engine    → the cadence tick: due-work scan, wave admission, state transitions,
            attention generation. Orchestration lives here and only here.
strategy  → turn composition + outcome evaluation policy (the experimentation surface)
sandbox   → SandboxProvider port; podman + agent-sandbox impls; image, nix mounts, TTL
harness   → InnerHarness port; opencode serve/API adapter; config materialization
github    → GitHub App: installation tokens, branch/PR provisioning, check polling
store     → SQLite: the only module that knows SQL; all durable state + events
```

## 3. Dependency rules (normative)

1. **One direction:** `api → engine → {strategy, harness, sandbox, github} → store`,
   plus `engine/… → anvil-api` for types. No module reaches sideways into another
   integration. `store` depends on nothing but `anvil-api` types.
2. **External knowledge stays at its boundary:** everything about opencode lives
   in `harness`; podman/k8s/nix-image in `sandbox`; GitHub in `github`; SQL in
   `store`. No other module imports their SDKs or knows their wire formats.
3. **Orchestration has one home:** only `engine` decides what happens next.
   `api` translates requests into engine/domain operations and never orchestrates.
4. **Nothing bypasses `store`:** all durable state is written through it; events
   and snapshots are written by the same transition call.
5. **Small public surfaces:** each module exposes a few types and functions;
   implementation details stay private to it.

## 4. Type-system invariants

Encode truth in the structure (see also the
[software-craft](../skills/software-craft/SKILL.md) skill):

- **Ids are newtypes** (`CommissionId(Uuid)`), not raw strings; no id of one kind
  is passable where another is expected.
- **States are enums carrying their exclusive data**
  (`Escalated { reason: EscalationReason }`, `Failed { cause: EnvFailure }`),
  exhaustive `match`, never stringly-typed columns. Encoding happens only at the
  `store` boundary.
- **Invalid inputs unrepresentable at the boundary:** campaign YAML parses once
  into checked types (`NonEmpty<Vec<Obligation>>`, validated `OwnerRepo`);
  downstream code consumes types, not raw payloads.
- **Failures are typed and explicit:** each integration boundary defines its own
  error type; `engine` converts them into commission state + attention, never
  panics, never swallows. The daemon exits only on bootstrap failure.
- **Config split by volatility:** static infra config in one TOML file; dynamic
  operational config (credentials, strategy defaults, budgets) in the database —
  **nothing operational requires a daemon redeploy.**

## 5. Diagrams

```
┌──────────────────────────── the cadence tick ────────────────────────────┐
│                                                                          │
│   every N seconds:                                                       │
│   ┌──────────┐   admissible commissions    ┌─────────┐                   │
│   │  store   │◄───────────────────────────►│ engine  │──► strategy       │
│   │ (SQLite) │   due turns, PRs to watch,  │  (tick) │    compose/eval   │
│   └────┬─────┘   stale heartbeats           └────┬────┘                   │
│        │              ▲                        │                        │
│  events+snapshots     │ run_session            │ branch/PR/checks       │
│  (same transition)    │ read_diff/events       ▼                        │
│        │        ┌────┴────┐            ┌──────────┐                     │
│        └────────►│ harness │            │  github  │                     │
│                  │ (opencode serve+API,│            │                     │
│                  │  inside sandbox)     └──────────┘                     │
│                  └────┬────┘                                             │
│                       │ SandboxProvider port: podman | agent-sandbox    │
│                       ▼                                                  │
│            one sandbox per commission (workspace persists)               │
└──────────────────────────────────────────────────────────────────────────┘

┌────────────────────────── one turn ─────────────────────────────────────┐
│ engine due-scan → strategy.compose (campaign ctx → spec → obligations →  │
│ gaps → live state) → harness.run_session (session.prompt, SSE events    │
│ ingested: tool calls, usage) → anvilctl done? → evaluate: PR checks /    │
│ diff → transition (+events) → reprompt | needs-review | escalate        │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────── preview router (own binary) ───────────────────┐
│ browser ──► <port>.<slug>.preview.<domain> ──► anvil-router              │
│   router watches substrate labels directly (k8s API / podman socket):  │
│   slug → sandbox, proxy to :port. No daemon in the path; token-gated.   │
└─────────────────────────────────────────────────────────────────────────┘
```

## 6. Decision log

| ADR | Decision | Rejected alternative | Why |
| --- | --- | --- | --- |
| 001 | Cadence tick, DB-as-truth, no resident per-commission tasks | tokio task per commission | Crash = restart = resume; no task lifecycle machinery; Symphony's proven posture |
| 002 | Waves/epochs with skip-gate | explicit DAG; agent messaging | Cheapest to implement/reason about; composes with retries; swappable policy |
| 003 | opencode serve-in-sandbox + v2 HTTP API driving | exec-per-turn as default | API covers prompt/wait/events/usage; config is file+env anyway; session continuity becomes a one-call strategy knob. Exec impl kept as fallback |
| 004 | GitHub polling | webhooks | No public ingress required; webhook path may come later via Tailscale |
| 005 | SQLite (WAL) behind a storage port | Postgres from day one | Single-replica MVP; Postgres is the HA-era swap |
| 006 | Five packages, client dep-tree isolated | one multi-call binary | Laptop nix builds compile only `anvil`'s small tree |
| 007 | `anvilctl` CLI over daemon HTTP | sandbox-facing MCP | No MCP wiring in sandboxes; harness-agnostic; prompt tells the agent the commands |
| 008 | PR checks as the verification gate; no deterministic test trigger | verify-on-done command | Agent tests at its discretion; corrections are cheap; checks are already the outer gate. `verify_cmd` kept as default-off knob |
| 009 | Rust | Go, TypeScript | Preference for its guarantees and style; crane for build caching; k8s/agent-sandbox CRD accessed via kube-rs (no Rust SDK exists — the CRD is just YAML we own) |
| 010 | Events for observation + snapshots for truth | full event sourcing | Replay machinery buys nothing here; incumbent's write-amplification failure mode warns against hot append paths — batch-bound + WAL-tuned |
| 011 | Preview router as separate binary | in-daemon proxy | Pages stay routable across daemon deploys/restarts; router code rarely changes |
| 012 | DB-canonical obligations, push/pull hybrid | workspace ledger as truth | Structured, auditable, relayed into prompts per turn; agent reports via `anvilctl`, evidence extracted deterministically |
| 013 | Port-in-hostname routing convention | registration/discovery | Statefuls nothing: `<port>.<slug>.preview.<domain>` needs only substrate labels; nothing to listen-check |
| 014 | Agent owns commits/pushes; Anvil provisions branch+draft PR at admission | control-plane pushes between turns | Agent autonomy; PR checks become a live verification signal from the first push; Anvil never commits |

## 7. Data model (non-normative sketch)

```
campaigns        id, name, slug, context, strategy_override, created
commissions      id, campaign_id, title, slug, repo, target_ref, target_sha,
                 wave, state, budget, strategy_snapshot, branch, pr_number
obligations      id, commission_id, ord, text, state(ev), added_by/audit
attempts         id, commission_id, n, session_id, heartbeat, tokens, outcome
turns            id, attempt_id, prompt_hash, started, ended, usage, result
events           seq(cursor), type, campaign_id?, commission_id?, payload
attention        id, commission_id, kind, payload, state(open/dismissed)
credentials      provider creds, github app key   (dynamic config home)
config          key/value operational settings
```

## 8. Test architecture

1. **Stub harness (primary):** deterministic canned turns drive the entire engine
   loop — wave admission, budgets, escalation, obligation mutation, resume
   re-baseline — with an in-memory `SandboxProvider`. No model, no podman.
2. **Real ports (mandatory):** podman integration (real provider, real
   container); kubeconform (manifests vs `Sandbox` CRD schema); opt-in k3d
   smoke (real agent-sandbox reconciliation); live opencode contract test
   (real serve instance, scripted prompt, event ingestion assertions).
3. **Stubs are never the excuse to skip tier 2.**

CI tiers map to the blogle/sdlc contract: `check` = fmt/clippy/stub tests
(cheap admission), `verify` = podman integration + kubeconform (merge
candidate), k3d smoke = opt-in lane. See [spec.md §3.5/§3.4](spec.md).
