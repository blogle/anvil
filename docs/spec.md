# Anvil — Product Specification

Status: **experimental (0.x)**. This document is the source of truth for *what Anvil
must do*. Everything marked **normative** is a MUST and changes only by deliberate
decision; everything in [§4 Non-normative current design](#4-non-normative-current-design-wip)
is work-in-progress scaffolding that we are explicitly free to violate once the loop
teaches us better. Where prior art informed a requirement, the mapping lives in
[§7](#7-prior-art-mapping) and the full digests in [research.md](research.md).

---

## 1. Objective

Anvil is a control plane and operator loop that drives
[opencode v2](https://opencode.ai) coding agents inside quarantined sandboxes toward
**merged GitHub pull requests**, unattended. Operators submit units of work; Anvil
spawns and re-spawns agents, tracks their progress, verifies their output, and only
asks for human attention when attention is genuinely required. The operator's scarce
resource is attention; the inbox is its budget.

Anvil replaces an incumbent system of the same name. The incumbent's context does
not inform this specification.

## 2. Terms

| Term | Meaning |
| --- | --- |
| **Campaign** | A unit of operator intent: an epic. An ordered set of commissions plus shared context. |
| **Commission** | The durable unit of convergence. Exactly one repo, one target ref, one branch, one PR. Carries obligations. |
| **Obligation** | A freeform-text requirement within a commission (`o1..on`, stable order). The convergence contract between operator and agent. |
| **Attempt** | One convergence episode: a series of agent turns working toward the obligations. |
| **Turn** | One agent invocation against the inner harness (one session-prompt cycle). |
| **Event** | Append-only, cursor-sequenced observation record (turn, gap, check, attention, mutation…). |
| **Attention item** | A deterministic control-loop state transition surfaced to the operator. The only inbox content. |
| **Strategy** | The turn policy: how a turn's prompt is composed and how the outcome is evaluated. Code, selected by config. |
| **Sandbox** | A quarantined execution environment (podman container or k8s `Sandbox` CRD) holding one commission's workspace. |
| **Inner harness** | opencode v2 running inside a sandbox. Anvil never executes agents on the host. |
| **Wave** | The dependency epoch a commission belongs to. Wave N+1 admits when wave N is terminal. |
| **Provider** | A sandbox substrate: podman (local/CI) or kubernetes agent-sandbox (production). |
| **Preview router** | A separate process that proxies `<port>.<slug>.preview.<domain>` to sandbox services. |

## 3. Normative requirements

### 3.1 Task model

- **N1 — Commission granularity.** A commission is exactly one repository, one
  target ref, one branch, and one PR. Cross-repo work is multiple commissions in a
  campaign. No multi-PR commissions.
- **N2 — Obligations are freeform and durable.** Obligations are ordered plain-text
  bullets; ids are auto-assigned and stable. They are durable state owned by the
  control plane, never agent-owned workspace state. Mutation (add/revise/drop) is
  allowed while a commission is non-terminal and MUST be audit-logged.
- **N3 — The convergence invariant.** For every active commission, the control loop
  MUST continuously attempt convergence — across daemon restarts, sandbox deaths,
  harness freezes, and quota exhaustion. Work MUST survive in the control plane's
  database and the commission branch. No failure mode MAY silently drop work.
- **N4 — Target deref.** At admission, the target ref is resolved to a commit SHA
  and both are recorded. Head movement on the target branch is detected by SHA
  comparison and surfaced to the agent.
- **N5 — Branch/PR provisioning.** At admission, Anvil creates branch
  `anvil/<campaign-slug>/<commission-slug>` and opens a draft PR whose body is
  auto-maintained (objective, obligation checklist, evidence links, check status).
  The agent owns all committing and pushing. **Anvil never commits.**
- **N6 — Convergence.** A commission converges when PR checks are green. There is
  no deterministic test trigger in the default configuration: the agent tests at
  its own discretion and relies on PR checks for verification; failed checks become
  gap reprompts. All green → `needs-review` + inbox item + PR marked
  ready-for-review. **Merging is a human act by default.** After convergence, the
  loop shepherds: if the PR becomes unmergeable (head moved), the commission
  returns to `active` and the agent is prompted to rebase — the agent resolves
  conflicts using its task context, not deterministic machinery.
- **N7 — Give-up policy.** Per-commission budgets (max attempts, max tokens, max
  wall-clock) plus a repeated-identical-gap tripwire. On exhaustion → `escalated`
  (terminal unless a human acts) + inbox item with triage actions. Budgets are
  guardrails with generous defaults, not cost control.
- **N8 — Inbox is deterministic.** Attention items arise only from control-loop
  state transitions, never from agent self-report or vibes. The taxonomy:
  1. review-ready (green PR), 2. budget/attempt exhaustion, 3. agent-requested
  attention (`anvilctl attention`), 4. environment/onboarding failure (broken
  flake, GitHub App permission denied), 5. unmergeable after agent rebase
  attempts, 6. interactive invitation, 7. attempt stalled (heartbeat or turn
  timeout exceeded — distinct from exhaustion: the attempt died rather than
  spent). Each item carries commission context and suggested actions
  (retry / revise / chat / takeover / cancel).
- **N9 — Waves.** Cross-commission dependencies are waves/epochs. Wave N+1 admits
  only when every wave-N commission is terminal: `merged`, `needs-review`,
  `escalated`, `failed`, or `cancelled`. One escalated commission MUST NOT deadlock
  a campaign (skip-gate). The dependency model is swappable; it is a scheduling
  policy, not a data model.
- **N10 — Interactive mode.** An operator may pause a commission (`interactive`):
  the control loop takes no autonomous action and runs no verification; relayed
  messages pass through raw (no hierarchical prompt composition); obligations
  added mid-chat are recorded durably but take effect at resume. `resume` MUST
  re-baseline: re-verify all obligations against the current workspace diff
  before the loop continues.
- **N11 — Lazy onboarding.** Any `owner/repo` may be referenced at submission. There
  is no registration step. Environment or permission failures surface as attention
  items, not pre-flight gates.

### 3.2 Execution

- **N12 — Inner harness.** opencode v2, driven over its HTTP API
  (`session.create`/`session.prompt`/`experimental.session.wait`, SSE
  `event.subscribe` for tool-call and usage ingestion) against a serve instance
  inside the sandbox, sessions persisted in the workspace so they survive serve
  restarts. The harness sits behind an `InnerHarness` port; an exec-per-turn
  (`opencode run --session`) implementation is the fallback, not the default.
  Provider config (models, credentials, MCP servers) is materialized as file+env
  **once at sandbox start** — the v2 API cannot set provider credentials at
  runtime, and credentials MUST never be at rest inside the sandbox. Session
  continuity (fresh-session-per-turn vs continuous) is a strategy knob.
- **N13 — Sandboxes are the security boundary.** Agents execute only inside
  sandboxes: podman locally, k8s `Sandbox` CRDs in production, behind one
  `SandboxProvider` port. opencode runs with full auto-approve inside the
  disposable sandbox. Default egress is unrestricted; a restrictive
  NetworkPolicy overlay is documented, not enforced.
- **N14 — Nix environments.** Target repositories MUST have a nix flake; the dev
  environment is `nix develop` in the checked-out workspace. Sandboxes use one
  generic image (opencode, git, nix client, `anvilctl`, basic tools) built with
  nix2container. All sandboxes share the host nix store (read-only bind) and
  delegate builds to the host nix daemon (`NIX_REMOTE=daemon`), so build
  artifacts are recycled across commissions per node. Cross-node caches are out
  of scope (attic/cachix is the acknowledged path).
- **N15 — One sandbox per commission.** The workspace persists across attempts
  and reprompts; sandboxes are recreated, not recycled, and deleted after a TTL
  grace once the commission is terminal. On k8s, sandbox pods are labeled by
  commission slug (the preview router depends only on these labels).
- **N16 — The engine is a cadence tick.** A single loop on a configurable cadence
  reads the database (the single source of truth), finds due work — admissible
  commissions, turns to evaluate, PRs to watch, sandboxes to reconcile — and acts.
  No resident per-commission task machinery. A restarted daemon resumes from the
  database with zero ceremony. MVP detectors: attempt heartbeat + turn timeout.
  Richer stall/pathology detection grows as additional detector functions inside
  the same tick; there is no separate watchdog loop.
- **N17 — Events for observation, snapshots for truth.** One append-only,
  cursor-sequenced, typed events log powers SSE, `logs --follow`, and incremental
  GETs. Current state lives in ordinary columns, written by the same transition
  functions that append events. Event appends MUST be batch-bounded and the
  store WAL-tuned (the incumbent's write-amplification failure mode is a known
  hazard). No replay-to-rebuild-state machinery.
- **N18 — Failures are explicit and never fatal to the loop.** Per-commission
  errors (harness call failed, sandbox won't start, flake broken) become
  commission state + an attention item; the daemon keeps ticking. The daemon
  exits only on bootstrap failure (unopenable store, unbindable listener).
- **N19 — Strategies are code, selected by config.** A strategy implements
  compose-turn and evaluate; variants are Rust types registered in code, selected
  by name with parameters (model, thinking level, prompt template id, session
  continuity, budgets). Every attempt MUST snapshot the full strategy selection
  and prompt hash for later comparison (turns-to-complete by model, by prompt).
  Strategies compose engine primitives (run-session, read-events, read-diff,
  read-PR-state), so multi-session role patterns (reviewer-agent, multi-model
  teams) are expressible without new engine machinery.
- **N20 — Signal channel.** The sandbox-facing control surface is a tiny
  preinstalled CLI, `anvilctl`, calling daemon HTTP with a per-commission token:
  `anvilctl done [--notes]`, `anvilctl attention <message>`, and obligation
  progress reports. It is NOT MCP. Progress reports carry agent-supplied evidence,
  recorded as claims rather than verified satisfaction.
  Evidence is extracted deterministically by the control plane (git diff, PR
  checks), never trusted from agent self-report alone. A turn that ends without
  `done` is not-done; the loop continues.

### 3.3 Interfaces

- **N21 — HTTP API.** REST+JSON over resources
  (`/campaigns`, `/commissions`, `/attempts`, `/events`, `/inbox`) with: SSE
  stream; `Idempotency-Key` honored on all POSTs; a batch submission endpoint;
  cursor-based incremental GETs (`?since=`); OpenAPI generated from code.
- **N22 — Operator MCP server.** Mirrors the operator surface (campaign/commission
  create and amend, obligations, chat, pause/resume, triage, status) so an outer
  agent can farm work to Anvil without babysitting it. One binary, same
  operations, no MCP-only powers.
- **N23 — Operator CLI.** `anvil`: `campaign submit <file.yaml>` (idempotent by
  content hash), `ps`, `status`, `logs`, `inbox`, `retry`, `revise`, `takeover`,
  `chat`, `resume`, `cancel`, and low-priority `probe repo`. Every read command
  supports `--json` with meaningful exit codes. No CLI-only capabilities: CLI and
  MCP are both thin clients over N21/N22.
- **N24 — Preview router.** A separate binary. It watches the substrate directly
  (k8s API for `Sandbox`/Services with commission labels; podman socket for
  labeled containers) and routes by convention: `<port>.<commission-slug>.preview.<domain>`
  → that sandbox's port. No registration, no daemon dependency — pages stay
  routable across daemon restarts. Single wildcard DNS + TLS at the router;
  token-gated.
- **N25 — Central harness config.** Model providers, credentials, and MCP servers
  are onboarded once (`anvil auth add`), stored in the control plane, and
  materialized into every sandbox at start. **Nothing operational requires
  redeploying the daemon.**
- **N26 — Telemetry.** Every attempt records model, thinking level, tokens,
  turns, and durations. OTLP export is optional; the database is canonical and
  the UI reads the database, never OTel.

### 3.4 Deployment & versioning

- **N27 — Single-replica control plane.** SQLite (WAL) on a PVC. HA/multi-replica
  is out of scope.
- **N28 — Deployable overlays.** kustomize base + overlays; a plain `Secret`
  template in base with documented sealed-secrets and external-secrets overlay
  examples; overlays must accommodate downstream cluster choices (CSI such as
  openEBS/ZFS, secret management).
- **N29 — Namespace strategy.** M1 deploys to the `anvil-next` namespace. The
  incumbent `anvil` namespace stays frozen. Consolidation (deprecating
  `anvil-next`, replacing the incumbent in `anvil`) happens only after the MVP
  is proven.
- **N30 — Experimental versioning.** Anvil stays 0.x until the milestones are
  complete and proven functional in production. Changelog via `blogle/sdlc`
  `.changes/` stubs only; never edit `CHANGELOG.md` directly; no major version
  before consolidation.
- **N31 — CI/CD per the blogle/sdlc contract.** `ci.nix` returning nonempty
  `check` (cheap PR admission) and `verify` (merge-candidate) attrsets; exposed
  as a validated `ci.<system>` output (`sdlc.lib.mkConsumer` over check/verify
  plus the `publish` app). Caller workflows are generated by
  `sdlc install` and pinned to the exact locked revision; they emit the stable
  contexts `sdlc / check`, `sdlc / verify`, and `sdlc / policy`. The canonical
  ruleset (`sdlc ruleset plan/apply`) requires check and policy; verify runs on
  merge candidates. Justfile recipes `ci-check`/`ci-verify`/`release-publish`.
  Candidate artifacts publish an immutable identity; promotion re-tags the same
  identity without rebuilding.

### 3.5 Process

- **N32 — Test architecture.** Stub-harness engine tests are the primary
  correctness instrument (deterministic canned turns drive the whole loop without
  a model or sandbox); real ports are tested for real: podman integration
  exercises the real `SandboxProvider`, kubeconform validates manifests against
  the `Sandbox` CRD schema, an opt-in k3d tier exercises real agent-sandbox
  reconciliation, and a live opencode contract test validates the `InnerHarness`
  adapter against a real serve instance.
- **N33 — Craft.** All implementation work is conducted under the
  [software-craft](../skills/software-craft/SKILL.md) skill: predictable structure,
  one identity per concept, minimal conceptual machinery, complexity behind
  cohesive boundaries, explicit failures, demonstrable correctness.
- **N34 — Work tracking.** Mutable work state (milestones, issues) lives on the
  ANVIL board (lific), organized into `M1`–`M4` modules — never in this document.
  This spec records only the milestone capability requirements (§5).

## 4. Non-normative current design (WIP)

Everything below is the current best guess, quarantine zone. Violate freely as
the loop teaches us.

### 4.1 Commission state machine (sketch)

```
pending → active → needs-review → merged
              ↑ ↕          ↓ (head moved / checks regress)
           interactive   active
active/needs-review → escalated (budget/tripwire)
any non-terminal  → failed (env), cancelled (operator)
```

States as Rust enums carrying exclusive data (`Escalated { reason }`), exhaustive
matches, encoded only at the store boundary.

### 4.2 `anvilctl` surface

`anvilctl done [--notes]` — completion claim, triggers evaluation.
`anvilctl attention <message>` — surfaces an attention item, may interrupt the turn.
`anvilctl report <obligation-id> --evidence <text>` — records an obligation claim.
`anvilctl report <obligation-id> --clear` — withdraws a claim. Both operations are
audit-logged. Subsequent turns and commission detail JSON show the latest claim;
the convergence verdict still relies on deterministic PR evidence.

### 4.3 Default strategy prompt composition

Hierarchical, per turn:

1. Campaign context (shared brief/spec)
2. Commission spec (verbatim)
3. Obligations with current evidence/gaps
4. Live external state (PR checks, target-head movement, branch state)
5. Operating instructions (branch, anvilctl, sandbox notes)

During interactive mode: none of this — relayed messages only.

Optional per-commission `verify_cmd` knob (shell command run in-sandbox on
`done`), **default off** — PR checks are the default gate.

Strategy knobs (per N7/N19): `model` (`provider/model#variant`, thinking
level via variant; materialized as a named agent config because the root
`model` field drops variants), `session` (`continuous` by default, `fresh`
opt-in; continuous sessions roll over to a fresh session once cumulative
session usage crosses `session_tokens`), `turn_timeout_secs` (per-attempt
wedge bound), `session_tokens`. Budgets live on the commission
(`{"attempts", "turns", "tokens"}`) plus campaign `quota_tokens` with
per-commission `quota_pct` for the account-wide ceiling; every breach
escalates with the spend stats. A gap identical for three consecutive
reprompts escalates instead of looping.

### 4.4 Operator CLI verbs

| Verb | Effect |
| --- | --- |
| `anvil campaign submit <file.yaml>` | Create campaign (idempotent by content hash) |
| `anvil commission add <campaign> <file.yaml>` | Add commission to a not-yet-started or new wave |
| `anvil ps [--campaign] [--watch] [--json]` | Commission table |
| `anvil status <commission>` | Single commission detail: obligations, gaps, attempt, previews |
| `anvil logs <commission> [--follow] [--session <n>]` | Event tail / attempt transcript render |
| `anvil inbox [--json]` | Attention items |
| `anvil retry <id> [--attempts n]` | Grant attempts to an escalated commission |
| `anvil revise <id> [--file | --add-obligation | --drop-obligation]` | Patch obligations ($EDITOR default) |
| `anvil takeover <id>` | → interactive; prints branch/PR/preview URLs |
| `anvil chat <id> [--message <text>]` | M4: terminal chat into the commission agent |
| `anvil resume <id>` | Exit interactive; re-baseline |
| `anvil cancel <id>` | Terminal cancel; PR left open |
| `anvil probe repo <owner/repo>` | Low priority: on-demand sandbox smoke test |
| `anvil auth add/list`, `anvil config set/get` | Central harness config |

### 4.5 Strategy examples (post-MVP experiments, not commitments)

- **Reviewer-agent strategy**: `evaluate` spawns an extra harness session with a
  skeptical-validator prompt over obligations/evidence/diff (generator/evaluator
  separation per Anthropic).
- **Team-solve strategy**: one "turn" = a scripted session sequence
  (plan → ideate×2 → solve → review → repair → verify) with the workspace ledger
  as IPC (per memdoor's GVS5H reproduction).

### 4.6 Campaign YAML (authoring shape)

```yaml
name: payments-refactor
context: |
  Shared brief for all commissions in this campaign...
strategy: { model: glm-5.3, thinking: high }   # optional, overrides defaults
commissions:
  - title: split invoice service from monolith
    repo: acme/payments
    target: main            # deref'd to SHA at admission (N4)
    wave: 1
    obligations:
      - extract invoice routes into services/invoice/
      - keep the public API contract unchanged; integration tests stay green
    # spec: |              # optional per-commission detail, included verbatim
```

## 5. Milestone capability requirements

Mutable work state (issues, sequencing) lives on the ANVIL board under modules
`M1`–`M4`. Each milestone is "done" when these capabilities hold:

- **M1 — Local loop.** On a laptop with podman: `anvil campaign submit` converges
  a single commission against a real repo with a nix flake — branch + draft PR
  provisioned, turns driven over the opencode API, obligations reprompted from
  PR-check gaps, `anvilctl` signals honored, attention items surfacing, retries
  surviving a daemon restart and a sandbox kill. The operator CLI observes all of
  it (`ps`, `status`, `logs`, `inbox`, `retry`, `revise`, `cancel`).
- **M2 — Campaigns & visibility.** Waves with skip-gating; strategy config +
  usage telemetry (model/thinking/turns comparisons); operator MCP server; web
  UI (inbox, campaign, commission drill-down with transcripts); `.changes`/CI
  machinery per the sdlc contract.
- **M3 — Production.** k8s agent-sandbox provider with shared-nix nodes;
  kustomize overlays + secret-management examples; the preview router in
  production; kubeconform + podman integration + k3d smoke tiers running in CI.
- **M4 — Interactive.** Pause/`interactive`, `chat` (CLI + MCP), resume
  re-baseline, obligations added during interactive work, convergence
  shepherding hardened (head-move → agent rebase loop).

## 6. Out of scope (explicit)

HA / multi-replica / Postgres; GitHub webhooks (polling only; a Tailscale-ingress
webhook path may come later); cross-node nix binary caches; auto-merge by
default; explicit `depends_on` DAGs; agent-to-agent messaging; benchmark/eval
harness (a future ambition, informally via telemetry); multi-tenant auth/OIDC;
live token streaming in the UI; non-Linux sandboxes; making the exec-per-turn
adapter the default.

## 7. Prior-art mapping

| MUST group | Informed by |
| --- | --- |
| N3 convergence invariant | Symphony: "for every open task, an agent is running in its own workspace"; dumb scheduler/runner |
| N6/N20 PR-check verification, no agent self-grading | memdoor team-solve: engine-run verification; harness-engineering: mechanically checkable thresholds |
| N19 strategy snapshotting + role patterns | Anthropic harness design: generator/evaluator separation, every component is a stress-testable assumption; harness2: harnessing as optimization |
| N12 fresh-context discipline as a knob | Ralph (Huntley): fresh process per iteration, state in files + git |
| N17 events for observation | zenith: two-tier durable record vs runtime cursors; incumbent's write-amplification scar tissue |
| N15/N13/N14 sandbox substrates | kubernetes-sigs/agent-sandbox (CRD, warm pools, SDK); shared-nix bind-mount patterns (GitLab runner, Pact) |
| N5 agent-owned pushes, PR as state | Symphony: agents write tickets/PRs; branch+PR as durable state |
| N9 waves | simplicity over DAGs (Symphony moved from rigid transitions to objectives; memdoor `requires:` deferred) |
| N32 real-port testing | harness-engineering: end-to-end autonomy checklist; incumbent Kind-CI realities |
| N33 craft discipline | harness-engineering: AGENTS.md as map; knowledge mechanically enforced |

Full digests with URLs: [research.md](research.md).

## 8. Amendment

Normative changes to §3 amend this document deliberately, with the prior-art and
invariant rationale updated in the same change. Non-normative sections carry no
such obligation.
