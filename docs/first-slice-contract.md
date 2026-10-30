# First-slice acceptance contract

**Status:** Approved development acceptance contract · **Target:** `v2` · **Commission:** Anvil autonomous first slice · **PR:** [#123](https://github.com/blogle/anvil/pull/123)

This document is the **authoritative, stable definition of FS-01 through FS-15** for the current development campaign. It codifies the previously approved obligation-driven steering. It is not a replacement for [the product specification](spec.md) or [architecture](architecture.md); those remain authoritative for domain semantics. The companion [evidence ledger](first-slice-acceptance.md) records progress and verification against these IDs. The implementation worker cannot relax, remove, or silently reinterpret any obligation. Any material changes require an explicit approved amendment, not an agent-created revision.

## Objective

Build the first operational slice of pre-1.0 Anvil: a Bun/TypeScript **autonomous** development controller that owns bounded Commission execution, state, OpenCode and sandbox interaction, GitHub/CI/Mergify integration, recovery, observability, API/MCP, and minimal UI. The outer convergence loop—not ChatGPT—must diagnose gaps and initiate authorized continuations, corrections, verification, and integration. The new implementation may not replace the incumbent until separately demonstrated to **match and exceed** its capabilities and reliability.

## Authority and environment constraints

- **No direct live cluster access.** The implementation worker must not use addrspace Kubernetes credentials or run live cluster commands, including kubectl and Helm. No kind, k3d, or simulated local cluster is authorized.
- **No dotfiles mutations.** Deployments are controlled separately through the dotfiles repository. The worker must not edit, commit, push, create PRs for, merge, or overwrite dotfiles manifests—especially the existing production `anvil` namespace. A future test namespace requires separately authorized dotfiles work.
- **No production cutover or release.** No merge to main/master, no replacement of existing deployment, no release/tag or SemVer major, and no automatic merge of PR #123. Implementation PRs target `v2`.
- **Local-first development.** Use `flake.nix` and pinned `flake.lock` to provide all tooling; Bun is the only application runtime/package manager. Do not depend on undeclared system Node, npm, Rust, or imperative installers. Use declarative Nix, including later container packaging.
- Follow `skills/software-craft/SKILL.md`: functional core / imperative shell, explicit immutable domain facts, closed state variants, no generic snapshot mutation API, minimal machinery, tests demonstrating behavior, no speculative frameworks. Follow SDLC changelog-fragment rules.
- Read the latest PR/branch and evidence ledger before attempting work. The worker controls implementation techniques and sequencing inside the approved objective, not acceptance criteria.

## Immutable obligations

### FS-01 — Reproducible Bun/Nix/SDLC toolchain

A clean clone can enter `nix develop`, install locked Bun dependencies, run fast format/type/unit/property checks, and run separate pinned Nix and SDLC CI/verify checks. `bun.lock` is the sole JavaScript dependency authority; generated `bun.nix` is derived and checked for drift. No obsolete Rust/Cargo/Crane scaffolding, Rust images, parallel npm lockfile, or undeclared host Node/npm toolchain. Nix expressions remain simple, modular by real responsibility, and declarative. Regenerate SDLC-managed files such as `renovate.json` through official tooling. Externally meaningful changes use SDLC `.changes/*.json` fragments with patch/minor only; do not manually edit `CHANGELOG.md`.

**Required evidence:** exact clean-clone/Nix/just and SDLC commands, output and exit statuses, generated lock drift negative check, package/build inventory, GitHub checks.

### FS-02 — Pure, cohesive domain engine

A single functional domain core owns Commission identity, lifecycle, decision authorization, state evolution, evidence policy, and Operation transition constraints. Pure `decide`/`evolve` or an equivalently cohesive interface receives immutable explicit inputs and yields exhaustive, typed results. No I/O, hidden global time/randomness, in-place input mutation, or provider calls. SQLite/HTTP/MCP/UI must not redefine domain policy. Repeated `Wait`, `Hold`, or `Escalate` under identical authoritative facts is a **no-op**: no new Operation, no unnecessary state version or SQL write. Organize production in conventional `src/`, tests in `test/`, and by domain responsibility, not transitional language suffixes.

**Required evidence:** source review plus tests for deep input immutability, exhaustive decisions, unchanged-state stable polling/version/DB row, and negative unauthorized transition cases.

### FS-03 — Governed intent, authority, and amendments

Only typed and properly authorized commands may create/admit, hold/resume, or amend an approved Commission. Objective, repository/target, budget, obligations, acceptance policy and authority are protected from generic snapshot updates, worker reports, and forged JSON. Amending requirements requires an approved actor and expected specification generation; modified criteria invalidate affected previous evidence/approval, unchanged criteria may retain applicable evidence. Terminal conclusion is immutable to ordinary amendments, unless a separate explicitly governed reopen contract is implemented. SQLite compare-and-swap must reject stale concurrent writes.

**Required evidence:** forged payload and wrong-actor tests, stale-generation/concurrent CAS tests, worker attempt to waive a criterion, terminal amendment rejection or governed reopening test.

### FS-04 — Durable Operations and crash-safe idempotency

Exactly one authoritative SQL Operation journal; persist approved transition and prepared Operation **atomically before external mutation**. Operation identity and target/preconditions are stable across restarts. A repeated logical instruction must not gain a new ID or cause duplicate OpenCode/GitHub side effects. An ambiguous external acknowledgement requires reobservation; absence alone is not safe-retry proof. Provider-proven safe retry retains the same logical identity and bounded retry count; `retry_authorized` remains unresolved until resolved. Ordered transactional migration tracking and SQLite reopening preserve state.

**Required evidence:** crash matrix at prepared, submitted, external effect before acknowledgement, ambiguous, retry authorized, during retry, and outcome recorded; real SQLite reopen; fake-provider dispatch counts; negative duplicate-operation counterexamples.

### FS-05 — Controller succession and exclusive Workspace writer

Only the actual current controller Lease holder with valid owner identity/epoch may authorize **new** mutable external operations. Lease ownership is not a remote exactly-once fencing mechanism. The original Operation's owner identity remains immutable, but a legitimate successor may inspect and record the predecessor's already-dispatched outcome without impersonation or replay. Controller A loses Lease, B acquires it, B resolves A's Operation, stale A cannot issue further writes. At most one authorized mutable writer per Workspace; independent verifier uses a separate snapshot/checkout.

**Required evidence:** A dispatch/crash -> B takeover/remote inspect/outcome test; stale A rejected; competing controllers/CAS; ambiguous outcome across takeover; no duplicated instruction or writer.

### FS-06 — Sound budget and stopping semantics

`maxAttempts` restricts creation of a **new Attempt**, not continuation of an already admitted first Attempt. Instruction/repair/cost/deadline limits apply to the effects they actually constrain. Usage monotonically persists across restarts, strategies, and context refresh. Repeated failure/unchanged evidence must lead to bounded waiting, strategy change, hold, or actionable escalation, not an infinite loop. Exhaustion prohibits new costly work but does not erase or block recording an already-valid authoritative delivery result, subject to authority and evidence.

**Required evidence:** zero/one/limit/overlimit tests, first Attempt with `maxAttempts=1`, exhausted budget with externally merged Candidate, restart budget retention and nonproductive-loop counterexamples.

### FS-07 — Candidate-, specification-, and delivery-bound evidence

Worker statements are submitted worker evidence, not independent acceptance. Every criterion's evidence is bound to applicable specification generation/criterion, immutable Candidate revision (and applicable dependency/check context), provenance, freshness, and disposition. Independent review is optional unless explicitly required. Candidate/spec changes invalidate affected verification, evidence, and approval. Pending checks/queued Mergify produce healthy waits, not repeat effects. Conclude only after authoritative evidence that the **registered PR in the approved repository and target** integrated the correct Candidate, with configured healthy checks and acceptance; a different PR with the same SHA cannot satisfy delivery.

**Required evidence:** foreign PR/repository/target, stale spec and SHA, worker-only vs required independent review, green-only/open-only/queued-only, future/expired observation, changed Candidate cases.

### FS-08 — Real autonomous outer convergence

A running controller, rather than a manually scripted runner or ChatGPT, decides and executes authorized `Wait`, `Continue`, `Repair`, `RefreshContext`, `ChangeStrategy`, `Verify`, `Integrate`, `Hold`, `Escalate`, and `Conclude` as appropriate. It persists intended effects, observes execution/git/checks/PR state, reacts to idle **and** in-flight repeated failures/context pressure at safe interruption boundaries, reobserves before retry, and stops wasted turns during external waits. Continuation prompts reconstruct Campaign/Commission/Assignment/Attempt/objective/Findings/remaining gaps from durable artifacts, not full transcript replay.

**Required evidence:** trace-driven autonomous lifecycle that chooses each action, in-flight watchdog tests, healthy wait/no-model-turn tests, bounded strategy change, restart and context-reconstruction tests.

### FS-09 — High-fidelity local test pyramid

Fast isolated domain/property/model tests with independently specified reference invariants, reproducible seeds and shrinking. Real SQLite, local HTTP and multi-process provider/test harness (where relevant) exercise same domain/application code as the daemon without Kubernetes or live credentials. Test duplicate/out-of-order notifications, stale observations, random restarts/ownership changes, active tool failures, CI fail/repair/pending/pass, PR queue/merge, and unknown Operation outcomes. Tests assert actual persisted state and external dispatch counts, not just decision labels.

**Required evidence:** exact replay commands, named tests, seeded failing/regression examples, a whole autonomous Commission lifecycle over real local state and local provider HTTP.

### FS-10 — Real production-intended provider adapters, locally validated

Implement bounded adapters for agent-sandbox provisioning/Workspace lifecycle, OpenCode session/messages/turn observation/instruction, credential separation and scopes, GitHub branches/PR/checks/CI, and Mergify queue/merge. Preserve provider-owned external IDs, correct failure/unavailable distinctions, and safe idempotency/reobservation semantics. Fakes support development but **must not substitute** for real adapters; use protocol-compatible local servers and/or recorded contract fixtures to validate adapters without touching the live cluster. Mark actual live provider integration separately unverified.

**Required evidence:** adapter contract tests, auth-scope assertions, mapping of real provider responses to canonical observations and operations, unsafe-retry counterexamples and honest externally unverified integrations.

### FS-11 — Runnable Bun daemon, authenticated HTTP and MCP

One executable Bun daemon runs migrations, persists Commissions and Operations, reconciles unattended work and recovers on restart. A Hono HTTP API and MCP expose the **same** authorized commands and read projections, rather than divergent policy logic: propose/admit, status/history/evidence, hold/resume, governed amend, steer existing Assignment without racing autonomous execution, and actionable escalation. Read views distinguish provider fact, worker assessment, observation freshness and pending work.

**Required evidence:** real daemon process startup via Nix/Bun, real local HTTP/MCP clients and auth-denial cases, persisted restart recovery and no duplicate effect after restart.

### FS-12 — Real operational UI

React/Vite, TanStack Router+Query, Tailwind/shadcn styled in the existing Ledger aesthetic; use actual authenticated API projections for Inbox, Campaign/Commission, Operations/evidence/Findings, current decision and next wake, and authorized steering/hold/amend. OpenCode Session and sandbox-preview links navigate to external actual targets rather than nested preview simulations. Do not present static mock data as live telemetry or create a second authority in the UI.

**Required evidence:** runnable UI against the real local daemon, browser/component integration checks for views and interventions, screenshot/preview reference plus the executed tests.

### FS-13 — Declarative build and deployment readiness

Build/package the actual Bun daemon/UI and sandbox runtime through declarative Nix, using nix2container with explicit sensible layering where useful, without arbitrary imperative package installation. Locally verify image/artifact contents, startup, migration, config/credentials assumptions, probes and ports. Produce a narrow deployment interface contract (images/digests, namespaces, secrets, health/readiness, compatible agent-sandbox and shared Nix interfaces) for a **separately authorized** dotfiles-managed namespace. Do not deploy or modify dotfiles.

**Required evidence:** exact pinned Nix build and package inspection/startup commands, deployment contract, known missing live validations.

### FS-14 — Incumbent parity and cutover protection

Inspect the existing `main/master` implementation and existing deployment contracts. Maintain an evidence-backed feature-by-feature matrix showing incumbent behavior and what the rewrite has implemented, verified, or lacks, including unattended convergence, sandbox/OpenCode, watchdog, GitHub/CI/Mergify, UI/API/MCP, recovery, auth, observability, provisioning and costs. Do **not** recommend moving Anvil development to the rewrite until capabilities and reliability match **and materially exceed** the incumbent.

**Required evidence:** grounded incumbent source references, runnable comparison or identified gaps, explicit cutover prohibition until independently accepted.

### FS-15 — Separately authorized live acceptance (external gate)

Full first-slice acceptance requires actual integration on an isolated addrspace namespace **deployed exclusively through an independently authorized dotfiles workflow**. Demonstrate real sandbox provisioning, OpenCode work, GitHub/CI/Mergify PR delivery, controlled interruption/recovery and authoritative merge, with the current production `anvil` namespace untouched. The implementation worker is **forbidden** from executing this or editing dotfiles. It may prepare a concrete acceptance runbook and required evidence. This obligation must be `BLOCKED_EXTERNAL` for this worker; it can only become `VERIFIED` after separate authorized execution and independent validation.

## Initial independently identified findings — close by test, not by assertion

- **G01 / FS-05:** successor B cannot resolve predecessor A's Operation because `evolveOperation` incorrectly requires A's owner identity to equal B's current authority.
- **G02 / FS-04:** `retry_authorized` omitted from unresolved predicate; restart can issue a new logical instruction.
- **G03 / FS-07:** delivery merge observation lacked registered PR, repository and target binding.
- **G04 / FS-06:** global attempt exhaustion blocks execution of the existing first Attempt when `maxAttempts=1`.
- **G05 / FS-03:** ordinary specification amendment accepted after terminal conclusion.
- **G06 / FS-02:** unchanged Wait/Hold/Escalate unnecessarily increments the durable Commission version.
  
For each finding: reproduce the old failure with an adversarial regression; implement the smallest cohesive fix; demonstrate the positive and negative behavior using actual test execution.

## Evidence ledger and convergence protocol

For **every FS ID**, record `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, `BLOCKED_EXTERNAL`, or `FAILED` in [first-slice-acceptance.md](first-slice-acceptance.md), with source path and commit, test paths/names, executed command/result, adversarial counterexample, and remaining limitations. Do **not** use `NEEDS_CRITERIA`: the criteria are all in this document. A worker claim, green CI check, or unexecuted test is not sufficient for the relevant gate. Never claim external/production integration from a local stub.

After each coherent checkpoint, update the evidence ledger, preserving objective, progress, exact failure traces, outstanding FS IDs and the next authorized action. Reconstruct continuation context from those durable artifacts rather than a full prior agent trajectory. If an obligation remains unverified, its gap remains visible. An issue is not 'done' because its code exists.

## Stopping rule / authority boundaries

1. **REVIEW_READY_CORE:** G01–G06 fixed with adversarial tests, PR #123 updated and relevant Bun/Nix/SDLC checks green; local domain core reviewable. This does **not** close FS-08–FS-15.
2. **LOCAL_SLICE_READY:** FS-01 through FS-14 all **VERIFIED**, with reproducible evidence. FS-15 is `BLOCKED_EXTERNAL` with runbook, and the PR(s) are ready for independent review. This is the maximum acceptance level available to this implementation worker.
3. **FULL_FIRST_SLICE_COMPLETE:** FS-01 through FS-15 independently accepted, including the separately authorized live gate. **Not available to the worker.**
4. **BLOCKED_OR_EXHAUSTED:** Identify exact affected FS IDs, attempted remedies, evidence, and precise missing authority or requirement. Stop only when continuing local work is truly impossible or budget is exhausted, not because FS-15 cannot be executed.

Do not silently modify this contract. The worker must not self-certify acceptance; submit verifiable evidence for independent review. Keep PRs reviewable and do not auto-merge.
