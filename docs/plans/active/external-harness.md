# Deliver an external harness around mainline Anvil

This ExecPlan is a living document maintained under repository-root `PLANS.md`.
Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must
stay current as work proceeds.

## Purpose / Big Picture

An operator should create a Campaign and Commission, watch OpenCode implement and
publish a change, inspect obligation claims, steer interactive development against
its live preview, hand control back, and see the Commission finish only when its
registered PR merges. Anvil should continue observing without human babysitting or
unnecessary model turns, and explain every intervention and healthy wait.

Implement [the controller specification](../../spec.md), using
[the infrastructure contract](../../infra.md) and [Ledger reference](../../ui.html).
This is an incremental extension of working mainline, not a revival of the v2
rewrite. Preserve provisioning, checkout/bootstrap, credential brokerage, previews,
profile authentication and shared Nix while replacing orchestration incrementally.

Planning baseline: branch `anvil/incremental-roadmap`, HEAD
`2afcae9a3a1077f499183ece0b0d008716c95e9c`, atop mainline
`3ce4f247aaae7b7f13bb9c89c99ab191ccd3d7a0`, with the agreed spec, infrastructure,
Fieldnotes and restored `PLANS.md` still uncommitted at plan creation. No PR is
recorded for this work. Reconcile the actual working tree and remote PR before
implementation; do not mistake the committed historical docs for the agreed spec.

The original request authorized drafting; subsequent operator approval authorized
local implementation, as recorded below. This revision persists the Campaign and
five Commission contracts; it does not itself execute them or grant new external
authority. Deployment, model spend and mutations to external repositories
require an approved target and budget. Isolated deployment and production protection
are governed in dotfiles; do not run the repository's generic deploy/cleanup recipes
against an assumed environment. Production promotion is outside this campaign.

## Progress

- [x] (2026-11-06) Drafted this plan from the agreed spec and inspected mainline entry points; no implementation evidence claimed.
- [x] (2026-11-07) Recorded the Campaign and five sequential Commission contracts; preserved historical criteria and evidence without promoting acceptance.
- [ ] EH-C1: Durable work and supervised execution. (partial implementation: reporting-skill bootstrap and turn/Attempt lifecycle correction; Commission journey unverified)
- [x] (2026-11-07 22:44Z) EH-C1 execution baseline reconciled: `anvil/incremental-roadmap` at `a4d36658a81001c572174906b96b6efe40f0eb92`, ahead seven of `origin/main`; no associated PR (`gh pr status`); only pre-existing untracked `node_modules/`, preserved. Local implementation authorized; integration target, registered PR, external model budget and ticket not assigned.
- [x] (2026-11-08 00:03Z) EH-C1 local increment: Campaign graph validation, additive durable Campaign/Commission records backed by the existing Task/Attempt/Session authority, explicit start, aggregate HTTP/MCP reads, hierarchical instruction and local fixture branch-change/restart demonstration. EH-C1 remains open: integration, live Kubernetes/provider evidence and identified usage/recovery gaps remain.
- [x] (2026-11-08) EH-C1 review/validation checkpoint: repaired the nullable Batch lookup, pre-submission dispatch stall, Kubernetes runtime-only nil-run panic and unsafe retry. Workspace build, format, all-feature workspace Clippy, 269 workspace tests and disposable local E2E passed. No PR or approved target; EH-C1 is not concluded.
- [ ] (2026-11-08) EH-C1 deployment-readiness follow-up authorized: finish useful local delivery/recovery/idempotency and capacity/budget evidence, without expanding into EH-C2 or a speculative workflow engine; rerun validation and retain external gates.
- [x] (2026-11-08) Local follow-up implementation: a scripted OpenCode worker committed/pushed to a disposable Git repo and published to a loopback PR fixture; start has durable key/receipt/restart replay; held submitted-run restart did not duplicate model request. Reviewed detached Task admission regression and added explicit held migration. Final validation and external gates remain open.
- [x] (2026-11-08 04:21Z) EH-C1 local deployment-readiness checks completed after v16 safety migration: workspace build, fmt, all-feature Clippy, 276 workspace tests, frontend, security and fixture E2E passed. The fixture PR is local-only, and the unknown submitted run was not replayed. EH-C1 remains open for approved integration/live observations.
- [x] (2026-11-08) Operator-requested frontend replacement increment on `8d9ef4b`: migrate the existing Session UI to a Next.js static-export Campaign/Commission/Session workspace, align daemon and local fixture serving, restore Session conversation/attach navigation, and fence uncertain browser command retries. Local checks are recorded below; this does not accept EH-C1 or unblock EH-C2.
- [x] (2026-11-08) Render-only addrspace preparation: on a separate dotfiles worktree, committed a standalone, unregistered `anvil-validation` overlay and audited its local render beside the pinned incumbent. It has no ingress or credentials and is **not deployable**; it was not merged, pushed, registered with Flux, diffed against the cluster, or applied. Live deployment remains blocked pending explicit approval and all gates below.
- [ ] EH-C2: Obligation-driven progress and reporting.
- [ ] EH-C3: Deterministic convergence and bounded recovery.
- [ ] EH-C4: Human control and review workspace.
- [ ] EH-C5: Authoritative delivery and end-to-end assurance.

## Surprises & Discoveries

Deployment-readiness reconnaissance at Anvil `db017c9` and dotfiles
`c456abb`: the incumbent dotfiles overlay still pins base and all three image
tags to historical Anvil `9fdd0b9`, and no validation namespace existed. The
new render-only overlay deliberately retains that base for shape comparison,
but current `k8s/base` has since changed. The validation proposal removes the
base's placeholder GitHub Secret and optional credential reference; it has no
ingress or real preview/router addresses, so treating a successful render as
a functional deployment would be incorrect. The normal dotfiles path is
reviewed PR/merge followed by Flux, **not** `just deploy` or direct apply.

At the 2026-11-08 frontend checkpoint the working tree already contained an
uncommitted Next.js rewrite, including deleted Vite sources, new untracked Next
routes/components and changes to Nix/daemon static serving. These changes were
preserved and reviewed rather than discarded. The old local E2E default still
pointed at `web/dist`, and its smoke check only searched for Vite `/assets`;
the daemon's optional built-asset test similarly skipped when `web/dist` was
absent. Both now exercise the Next export and its `/_next/static` assets. The
browser's stored idempotency key is tied to the exact payload/version; a reset
after an ambiguous transport or server outcome could duplicate effects, so
reset is only offered after a definite rejection. This browser guard is not a
substitute for durable backend receipts or recovery of unknown external effects.

EH-C1 source reconnaissance at `a4d3665`: the legacy batch scheduler can dispatch
worker turns, while the Reconciler executor currently dispatches CreateAttempt only;
SendTurn is disabled pending uncertain-outcome recovery. Task graph submission has
atomic durable idempotency but no Campaign identity. An internal Task-to-Commission
adapter must not become a second execution writer; existing Task public routes are
retirement candidates for EH-C4, not a new product contract. These are inspected
source facts, not runtime acceptance.

EH-C1 deterministic fixture revealed two execution races: legacy `create` waits
for a held worker turn before the Attempt can bind its Session, and pinned v2
OpenCode's `POST /api/session/{id}/prompt` is synchronous (not an asynchronous
acknowledgement). The first run edited a file while the Attempt remained
provisioning/unbound; a second run restarted before the model received input and
left a submitted run with no edit. The corrected fixture releases its gate and
observes the edit before restarting. These failures are retained, not promoted
to successful unknown-effect recovery evidence. See Artifacts and Notes.

Mainline already contains durable tasks, Attempts, scheduler capacity, reconciliation
and effect execution. `crates/anvild/src/lib.rs` has `run_task_reconciliation_tick`,
`run_reconciler_executor_tick`, `run_batch_scheduler_tick` and
`deterministic_attempt_session_id`. `crates/anvild/src/store.rs` uses SQLite WAL,
transactional idempotency and failpoints. Adapt these rather than inventing another
orchestrator/store. This is source inspection, not evidence that current behavior
satisfies the spec.

`just build` builds frontend plus workspace binaries, but the local E2E script
otherwise performs package-only builds. Use its `ANVIL_PREBUILT_BIN_DIR` interface
after a workspace build. The script binds localhost ports 8080, 4097 and 4098 and
must not run alongside another service using them. Its temporary fixture disables
Git TLS verification; never carry that environment into a real deployment.

## Decision Log

2026-11-08 — Operator selected `addrspace/anvil-validation` as the first
isolated target and prefers a real model plus repository scenario over a
fixture-only first live run. These are planning preferences, **not** approval
to apply manifests, publish images, spend model budget or mutate a repository.
When prompted for repository/branch/task/USD/time bounds, the operator selected
the response option to provide exact bounds but did not supply the values;
the integration target, registered PR and bounded scenario remain unassigned.
The operator confirmed independent credentials and validation-only routing
still need provisioning. Do not infer authority or reuse incumbent credentials.

2026-11-08 — Operator direction for prospective deployment preparation: use a
separate addrspace validation namespace in dotfiles alongside the pinned incumbent.
This is planning direction only, not approval to deploy or alter production. Until
separately approved, preparation is render-only: no production overlay, image,
ingress, PVC, or secret changes, and no promotion. Any live deployment requires
explicit approval naming the target, immutable image digest, independent credentials,
bounded cost, and bounded scenario. Stop if any item is missing. SDLC's dev lifecycle
and changelog fragments are development workflow artifacts, not runtime reporting
evidence. The repo-local, Nix-pinned skills CLI is distinct from the runtime reporting
skill installed in a Workspace; neither substitutes for the other or proves runtime
reporting behavior. This direction does not change acceptance criteria or claim a
deployment/validation result.

2026-11-07 22:44Z — EH-C1 implementation binding: use the existing SQLite store,
Task-backed execution authority and Attempt/Session records as internal migration
adapters; introduce Campaign/Commission public vocabulary and additive membership,
not a second scheduler. Preserve old Task endpoints during the bounded EH-C1 to
EH-C4 client migration and record their removal as EH-C4 work. The actual working
branch is `anvil/incremental-roadmap`; no target approval or PR exists, so no merge
or external execution is authorized by this checkpoint. Source baseline `a4d3665`.

2026-11-08 00:03Z — Submission alone never dispatches work: the versioned
`POST /v1/commissions/:id/start` gate authorizes the existing scheduler.
Commissions use their Task ID internally and preserve a running strategy Attempt
after turn completion; `start_after` cannot treat a mere turn as completion.
An ambiguous prompt submission stops with recovery required rather than blindly
replaying. The local fixture demonstrates a branch edit then restart; neither
this nor a worker's claim marks the Commission integrated. These are bounded
EH-C1 decisions, not a redesign of provider execution or approval policy.

2026-11-08 — Operator authorized closing local EH-C1 deployment-readiness
gaps before seeking isolated deployment, favoring actual fixture evidence over
speculative redesign, and explicitly authorized pruning `node_modules/`.
At follow-up start HEAD `39f0efa5375842fe813dc751df27597ec70406f1`
on `anvil/incremental-roadmap`, clean tracked tree, no associated PR; root
`node_modules/` was already absent, and ignored `web/node_modules/` was removed
with `rm -rf -- node_modules web/node_modules` (exit 0). Prescribed frontend
validation may recreate the ignored directory; prune again after verification.
No approved integration target, external model budget or deployment target was
added by this authorization.

2026-11-08 — To address review finding that a Task accepted without Batch or
Commission could be silently claimed by the legacy worker with an empty prompt
or remain queued without an executor, use an additive v16 migration and hold
new/historical unattached Task intent as `awaiting_controller_mode`. A versioned
transfer to the Reconciler clears the hold. This is an internal safety adapter
for the bounded Task migration period, not expansion of the Task public API;
EH-C4 deletion remains required. The old detached claim assertion had to be
replaced with a hold/transfer regression test, rather than deleted without
coverage. This change is relevant to EH-C1-O2/EH-01/EH-10 and EH-C1-O4/EH-04.

2026-11-07 — Operator-approved API scope amendment: delete the Task API rather
than retain it as a compatibility product surface. Retain batch operations over
Campaigns and Commissions, not Batch/Task as competing work identities. New APIs
must support efficient set-oriented reads and commands, durable idempotency,
cursors and concurrency preconditions. ChatGPT must be able to inspect an Inbox
or Campaign aggregate without per-item fan-out, steer a set in one request and
create/orchestrate a Campaign and its Commissions in one request. This adds EH-13
and refines the Commission contracts below; it does not authorize external effects
or bypass approval, budget, control-mode or dependency gates. Task API removal is
required by EH-C4, after client migration, rather than an optional EH-C5 cleanup.

2026-11-07 — Operator-requested planning revision: persist the spec-completion
Campaign as five sequential Commissions in this existing ExecPlan, rather than
creating a competing campaign document. The Commission contracts below replace the
six-milestone execution sequence. Existing EH-01 through EH-12 normative criteria,
external gates and historical evidence remain intact. Prior M1–M6 references are
historical work-package references, not the current admission order. Research and
optional extensions remain separately gated; any reduction of an existing acceptance
criterion still requires an explicit approved amendment.

2026-11-06 — User-approved design, recorded by the planning assistant: an Attempt
is a bounded strategy; it begins with a fresh OpenCode Session. Session replacement
within an Attempt is context/runtime recovery, not a fresh strategy or budget.
Retain healthy autonomous Sessions as baseline and interactive continuity always;
evaluate fresh-per-prompt autonomous context separately.

2026-11-06 — User-approved design: install reporting instructions as a Workspace
skill. Compare a structured response path with a reporting tool before selecting
transport. The plugin reports/wakes; Anvil alone owns autonomous dispatch.

2026-11-06 — User-approved scope: deterministic failure/recovery rules first;
LLM failure classification is deferred research. Ordinary worker claims ordinarily
supply product obligation evidence. The implementation acceptance below separately
requires tests and actual observations; do not impose independent certification on
every product claim.

2026-11-06 — Planning choice: build a thin end-to-end slice and observe it in
isolation before expanding breadth. Do not gate the first runnable slice on a full
Ledger redesign, generalized workflow engine or context-policy benchmark.

## Outcomes & Retrospective

2026-11-08 deployment-readiness decision point: attempt an **isolated** live
deployment only after the operator explicitly approves a named addrspace
validation target and bounded scenario/model cost, reviewed dotfiles
revision/procedure, a committed Anvil source revision and immutable published
image digests for all required images, independently scoped credentials, and
rendered namespace-only diff. The render-only proposal cannot itself be
applied: it intentionally contains historical image tags, no usable
credentials, no ingress and invalid example routing. Publish/registry access,
credential creation, PR/Flux registration, any cluster observation and model
spend remain separately gated. No approval or external integration identity
is inferred from the user's request to race toward readiness; EH-C1 remains
open and EH-C2 remains start-blocked.

2026-11-08 frontend checkpoint: the operator can use a Next.js static-export
entry point for Campaign submission, aggregate inspection, versioned Commission
start and Session conversation navigation against existing APIs. It is a minimal
EH-C1 entry point, not the full Ledger, interactive control, obligation reporting
or autonomous convergence in EH-C2–C5. No registered PR/approved integration
target, external model budget, live deployment approval or authoritative merge
has been supplied. The sequential EH-C2 start gate remains closed. Existing
historical EH acceptance rows remain unverified; this checkpoint adds local
frontend and routing evidence only, with results and limits below.

2026-11-07 22:44Z EH-C1 resumed from committed planning revision `a4d3665`, not
the historical baseline at line 21. No EH-C1 obligation is accepted by this
reconciliation; external integration and live model/provider observations remain
blocked on approved target/budget. The minimum safe next step is local implementation
and deterministic evidence, then request target/PR integration authority.

2026-11-08 00:03Z: local Campaign submission and worker branch-edit/restart
identity are observable in a disposable fixture. There is no accepted live
provider/Kubernetes or registered-PR evidence, no demonstrated commit/push/PR
publication, no safe same-branch strategy retry and no complete model cost/time
budget. EH-C1-O1–O4 remain partial; no Commission or EH acceptance row is marked
verified. EH-C2 remains start-blocked. Retire the Task public routes/tools and
legacy Task-centric completion bridge during the governed EH-C4 migration only
after their safety replacement is established.

2026-11-07 planning revision: the current next action is EH-C1 against the reconciled
working tree, followed by EH-C2 through EH-C5. No Commission is accepted or integrated
by this planning change. Earlier statements below directing continuation of M1 or
deployment before M3 describe the superseded sequence, not current instructions.

Implementation is authorized by the operator's request. M1 has started with a
small Workspace-bootstrap change: the Kubernetes Sandbox init container now installs
`.opencode/skills/anvil-reporting/SKILL.md` into the project Workspace. The skill
defines progress, obligation-claim, artifact and blocker reporting and explicitly
distinguishes claims from integration. This is guidance only; durable attributed
report ingestion and the Commission-to-merge journey are not implemented by this
change. All acceptance rows remain unverified. No deployment, model spend, external
repository mutation, or dotfiles change has been made. Continue M1 locally; stop
before M2's isolated deployment gate until its target and budget are approved.

2026-11-07 execution reconciliation: branch `anvil/incremental-roadmap`, HEAD
`5eb2b4308e0ff6c5faf6e0f7d66a660f052592f6`, ahead 4 of `origin/main`; no local
tracked modifications and no PR recorded. The only pre-existing untracked path is
`node_modules/`, left untouched. This is the current implementation baseline; the
reported bootstrap change and its verification are already committed. M1 remains
incomplete and no claims are made about a Commission-to-merge journey. No external
target, model budget, or deployment approval is recorded, so work remains local.

2026-11-07 M1 increment: Reconciler-observed OpenCode turn completion now persists
`state=completed`, `turn_state=completed`, `lifecycle=running`, no `exit_reason`, and
no `ended_at`. It releases scheduler execution capacity while retaining the strategy
Attempt and bound Session; legacy and shadow-owned turns retain their prior behavior.
The store transition is transactional and rejects non-Reconciler ownership and
non-running Attempts. This is an intermediate persistence correction, not a claim
that continuation dispatch, Campaign/Commission records, reporting ingestion, or the
Commission-to-merge journey are complete. EH-02 remains unverified pending the
correlated end-to-end/restart evidence required by the acceptance table.

## Context and Orientation

A Campaign supplies purpose and shared contracts. A Commission owns objective,
versioned obligations, repository/target, branch, PR and optional ticket. Its
Attempts bound strategies and recovery budgets. A Session is literally OpenCode's
conversation/execution identity. A Workspace is the persistent checkout/runtime;
a Candidate is the observed commit SHA. Work complete, review ready and integrated
are separate derived milestones, not three synonyms for done.

Keep validation and shared domain transitions in `crates/anvil-core/src/lib.rs`.
`crates/anvil-reconcile/src/lib.rs` is the pure decision surface;
`frozen_v0.rs` is a compatibility reference, not a new implementation target.
The daemon's `lib.rs`, `store.rs` and `store/scheduler.rs` own HTTP orchestration,
durability and scheduling. `github.rs` and `crates/anvil-github-observer/src/lib.rs`
adapt provider observations; `local.rs` supplies the local runtime. Inspect actual
ownership before moving behavior between them.

`crates/anvilctl`, `crates/anvil-mcp` and `web/src` are existing operator clients.
The frontend currently includes `app.jsx`, `sessions.jsx`, `detail.jsx`, `state.js`,
`runtime.jsx` and `opencode-link.js`. Preserve useful Session navigation while adding
Commission views. `crates/anvil-router` is Anvil's preview proxy, distinct from the
upstream Agent Sandbox Router. `tests/local-e2e.sh`, `crates/anvil-test-model` and
`crates/anvil-test-world` provide reusable test infrastructure. `flake.nix` pins
OpenCode at `9b4ec5714d481559990db0a816d5dec19541a814`; record the resolved runtime
version in experiments rather than assuming a different installed CLI matches it.

## Plan of Work

### Campaign EH — Converge Anvil to the controller specification

Purpose: deliver the operator journey described in Purpose / Big Picture and all
mandatory behavior in `docs/spec.md`, while preserving the infrastructure contract
and existing working mainline behavior. This file is the durable Campaign record
until Anvil can represent it itself; the IDs below are planning identities, not
claims that corresponding runtime records already exist. Do not create a parallel
acceptance ledger when importing the contracts into Anvil: retain these IDs and
link runtime identities and evidence back here.

Shared contracts: reuse core validation and existing reconciliation/store authority;
keep one writer; preserve budgets and historical evidence; distinguish worker claims
from independently observed facts; never equate implementation with acceptance.
Use Campaign/Commission vocabulary for the public work API. Batch is an operation
shape, not a separate domain aggregate. The Task API must be deleted; temporary
internal migration adapters and historical database readers are not justification
for retaining public Task endpoints or MCP tools. The bulk interaction contract
below applies from EH-C1 onward rather than being retrofitted in the last phase.
Each Commission targets this repository and its operator-approved integration branch.
The historical branch baseline above is not approval of a current target. Before
starting each Commission, record its actual starting SHA, approved target, working
branch, registered PR, budget and any ticket here. Those per-Commission execution
bindings are currently unassigned; no PR or approved external budget is inferred.

EH-C2 is start-blocked on EH-C1 integration; EH-C3 on EH-C2; EH-C4 on EH-C3; EH-C5
on EH-C4. Each starts from the prior integrated baseline and ends only after its own
registered PR authoritatively merges into the approved target. Local completion of
an increment does not satisfy that gate. Surface missing approval rather than
starting the next Commission. Each Commission adds a usable increment; later phases
must preserve earlier behavior and evidence must be rechecked for applicability.

The four obligation IDs per Commission below are stable grouping handles for its
contract, not a replacement for EH-01–EH-12. Record their evidence and residual gaps
in the existing acceptance ledger and Artifacts and Notes, citing both IDs. All
Commission obligations are currently unverified. Evidence must identify the relevant
obligation/version, Candidate, actual execution provenance, implementation references,
verification artifacts and remaining limitations. Keep this record usable outside
Anvil so an unfinished evidence implementation cannot certify itself by displaying
green status.

### EH-C1 — Durable work and supervised execution

Objective: an operator can create work, run a worker and inspect durable execution
state. Operator-directed continuation is acceptable in this phase.

| Obligation | Acceptance contract | Existing criteria |
| --- | --- | --- |
| EH-C1-O1 | Persist Campaign → Commission → Attempt → Session identities, relationships and specified lifecycle/work-contract fields. A turn ending does not end the strategy Attempt. | EH-02 |
| EH-C1-O2 | Admit only within capacity and explicit start gates; establish a persistent Workspace, branch and bound Session without regressing checkout, credentials, Nix or preview. | EH-01, EH-10 |
| EH-C1-O3 | Supply the hierarchical work instruction and support worker implementation, tests, commits and PR publication; capture the first correlated execution trace. Provide idempotent Campaign-with-Commissions submission and aggregate reads with cursor foundations, without requiring per-Commission creation/query calls. | EH-03, EH-09, EH-11, EH-12, EH-13 |
| EH-C1-O4 | Preserve work identity and aggregate usage across controller restart and Session recovery, without duplicate execution authority or simultaneous writers. | EH-02, EH-04, EH-05 |

Demonstration: create a Commission, start its worker, produce a branch change,
restart the controller and recover the same work without duplicate execution.
Capture actual identities and durable state before/after. Provide a minimal usable
operator entry point; full Ledger design and autonomous gap selection are not
prerequisites. Distinguish local fixture results from live runtime observations.

### EH-C2 — Obligation-driven progress and reporting

Objective: operators can inspect a versioned acceptance contract and revision-bound
claims, rather than relying on prose-only progress.

| Obligation | Acceptance contract | Existing criteria |
| --- | --- | --- |
| EH-C2-O1 | Authorized obligation creation, amendment and removal preserve versions, invalidation semantics and audit history. | EH-07 |
| EH-C2-O2 | Install and exercise the reporting skill; select a transport using the pinned-runtime comparison, with actual execution provenance, durable receipts and deduplication. | EH-03, EH-08 |
| EH-C2-O3 | Expose missing, stale, inapplicable and challenged evidence as gaps; keep worker claims distinct from provider facts. Reports cannot amend obligations, approve work or conclude a Commission. | EH-07, EH-08, EH-09 |
| EH-C2-O4 | Expose obligations, evidence, artifacts and gaps through a minimal Commission inspector and corresponding API/MCP capabilities. Set-oriented reads include useful progress/gap summaries and selective expansion without per-item evidence queries. | EH-11, EH-13 |

Demonstration: receive and redeliver a claim without duplication, advance the
Candidate, amend a requirement and challenge a claim. Observe the correct gaps
without erasing history. Exercise malformed/foreign reports and lost receipts.
Compare reporting transports before selection; implementing both permanently is
not required. Repairs may still be directed by an operator until EH-C3.

### EH-C3 — Deterministic convergence and bounded recovery

Objective: the harness advances observed gaps autonomously without racing workers,
replaying uncertain effects or consuming model turns for healthy waits.

| Obligation | Acceptance contract | Existing criteria |
| --- | --- | --- |
| EH-C3-O1 | Reconcile execution, reports, branches/checks/PRs, Mergify and relevant health through events plus periodic observations that recover missed events. | EH-04, EH-09 |
| EH-C3-O2 | Dispatch focused continuation or Candidate-bound repair; wait without model turns for active work and external prerequisites; surface required decisions. | EH-03, EH-04, EH-11 |
| EH-C3-O3 | Serialize dispatch at safe boundaries, recheck facts, suppress repeated unchanged instructions and reobserve uncertain effects before replay. Persist multi-Commission orchestration intent once, execute through the same authority and expose per-command receipts/outcomes across retries and restart. Plugins may wake reconciliation but never own prompting. | EH-04, EH-08, EH-13 |
| EH-C3-O4 | Use substantive progress signals and recorded configurable allowances for watchdog recovery, Session reconstruction, strategy replacement and escalation; stop new costly work on exhaustion or unknown outcomes without resetting budgets. | EH-02, EH-05, EH-12 |

Demonstration: exercise missing reports, failed checks, unchanged failures, pending
CI, dropped events, lost acknowledgements, Session loss and exhausted budget.
Traces must explain each action/wait and show preserved budgets and one writer.
A minimal actionable queue is sufficient here; full human control follows in EH-C4.

### EH-C4 — Human control and review workspace

Objective: humans can safely intervene, develop interactively and review the same
work the controller manages.

| Obligation | Acceptance contract | Existing criteria |
| --- | --- | --- |
| EH-C4-O1 | Serialize takeover and provide Session steering/live preview while retaining conversation continuity and binding obligations. | EH-01, EH-06 |
| EH-C4-O2 | Defer routine autonomy, testing and integration during interactive control, permit explicit checks and resume only on explicit handback, preserving human changes and deferred work. Inactivity/watchdog alerts cannot hand back control. | EH-03, EH-06 |
| EH-C4-O3 | Provide authorized, audited hold/resume, evidence challenges, obligation amendments and repair steering consistently through UI/API/MCP and existing CLI surfaces. Accept a set of explicitly targeted commands idempotently in one request, enforcing per-item versions and human-control gates. Migrate clients and delete public Task routes/tools rather than retaining aliases. | EH-06, EH-07, EH-11, EH-13 |
| EH-C4-O4 | Complete Focused Inbox, Everything, Campaign gates and the Commission review packet, with exact working Session, PR, ticket and preview links. An Inbox query returns actionable state for a bounded set in one request and supplies the identities/preconditions needed for one subsequent bulk steering request. | EH-10, EH-11, EH-13 |

Demonstration: take over active work, make a UX change, remain inactive through
watchdog thresholds and explicitly hand back. Show retained changes, deferred checks
and subsequent repair. Exercise navigation and commands against the daemon, not only
component mocks. Repository approval remains a separate provider-observed fact.

### EH-C5 — Authoritative delivery and end-to-end assurance

Objective: complete the approved-work-to-integration journey and make its behavior
auditable against the full specification.

| Obligation | Acceptance contract | Existing criteria |
| --- | --- | --- |
| EH-C5-O1 | Distinguish work complete, review ready and integrated; conclude work only on authoritative merge of the registered PR into its approved target, never a worker assertion or unrelated/wrong-target merge. | EH-09 |
| EH-C5-O2 | Enforce default parallel-start/integration dependencies and explicit start gates, reject invalid references/cycles, default PRs to integration:review and respect GitHub/Mergify approval policy. Record authoritative integration even while held. | EH-09, EH-10 |
| EH-C5-O3 | Complete durable, correlated, exportable telemetry with required decision/context/outcome fields, credential redaction and measured/estimated/stale/unavailable distinctions. | EH-12 |
| EH-C5-O4 | Validate the complete approved isolated runtime journey, preserve mainline/infrastructure behavior and reconcile every mandatory specification requirement and existing EH acceptance row with current evidence or an explicitly approved amendment. Demonstrate bounded-call Campaign orchestration and Inbox-to-bulk-steering, including retry/restart and cursor recovery, with no public Task surface. | EH-01–EH-13 |

Demonstration: run dependent Commissions through implementation, challenge, repair,
review and authoritative merge. Reject premature completion and wrong-target/unrelated
merges, record a valid merge while held and export the correlated trace. Include
restart and human handback with real OpenCode, preview and provider observations.
Actual external work requires the separately recorded target, procedure and budget;
fixtures cannot replace this live acceptance evidence.

Telemetry begins in EH-C1 and grows throughout; EH-C5 validates rather than retrofits
it. Deployment, optional reviewer workers, cross-worker messages, LLM classification
and production promotion are not new mandatory deliverables. The previously required
bounded context-policy comparison remains an explicitly gated acceptance activity
under EH-12 unless amended by the operator; it cannot reset budgets or compromise
interactive continuity. Stop at missing environment, cost or approval gates.

### Bulk interaction contract — shared across EH-C1–EH-C5

These are observable API/MCP capabilities, not prescriptions for route names or a
new generic workflow language. HTTP, MCP and clients share application operations,
authorization, validation and durable receipts. One MCP tool call must translate to
one bulk application request, not require ChatGPT to discover or command every
Commission separately. Internal provider observation and execution may be asynchronous.

**Read sets and aggregates.** Query selected Campaigns/Commissions or a filtered
Inbox in one request. Return actionable summaries including lifecycle/control mode,
current Candidate, obligation gaps/challenges, checks/review, dependencies, decision
or wait reason, observation freshness, and relevant versions/generations. Include
counts, stable identities and optional bounded expansion for evidence and Attempts;
do not require transcript retrieval or per-item calls to understand ordinary progress.
An aggregate Campaign read includes its Commission graph and progress. A bounded
Inbox response includes the context and preconditions needed to steer its items.

**Cursors and bounded responses.** Support stable pagination and incremental changes
for the same query scope, with explicit continuation/change cursors and observation
or snapshot identity. Document ordering and consistency; concurrent updates must not
silently skip work. Distinguish page cursors from change watermarks. Signal expired
cursors/reset requirements and provide a full-snapshot recovery path. Report totals
and truncation explicitly; large campaigns may require bounded pages, but ordinary
set reads must not become one-call-per-item fan-out. Never silently advance a change
watermark past unreturned changes. Scope cursor data to the authorized caller/query.

**Bulk commands.** Accept explicitly identified Campaign/Commission commands in one
request, including steering multiple Inbox items, hold/resume and governed amendments.
Read-only filters may identify work, but a mutation must freeze its resolved target
set in its durable acceptance record; retries must not act on newly matching items.
Include per-command expected versions/specification generations as applicable, and
preserve distinct command meanings: steering does not amend requirements or implicitly
hand back human control. Recheck safe execution boundaries before dispatch. Stale
items produce explicit conflicts rather than overwrite newer human or controller work.

**Idempotency and outcomes.** A durable scoped request key plus canonical payload
identify a logical request. Reusing a key with a different payload is a conflict.
Each command has a stable identity and receipt so it can be inspected or safely
retried individually or as part of the original envelope, without duplicate prompts,
evidence, amendments or resource creation. Specify retention/replay limits and never
silently treat an expired key as permission to repeat an uncertain external effect.
Lost responses and controller restarts preserve accepted identities and outcomes.
Return per-item accepted, deferred, conflicted or rejected dispositions and correlate
them with later execution outcomes, including unknown effects. Acceptance is not
execution or integration. Distinguish envelope validation failure from mixed item
results; do not imply all-or-nothing external effects or roll back a dispatched prompt
because another item failed. Unknown outcomes require observation, not blind replay.

**Campaign orchestration.** One request can submit a Campaign with its Commission
contracts, obligations, explicit dependency edges, execution targets and bounded
approved orchestration intent. Validate and persist the graph and intent atomically
before admission; invalid references/cycles or unauthorized configuration do not leave
a partially created graph. Use request-local Commission references to avoid requiring
server-ID round trips. Return the created identities, aggregate projection and durable
receipt in the same response. Execute admitted work asynchronously under the normal
controller, with dependencies, capacity, budgets, repository approval and explicit
human handback still binding. One request authorizes only its declared scope, not
arbitrary future actions or unbounded model spend. Subsequent orchestration updates
use the same versioned/idempotent command boundary, not destructive resubmission.

Required demonstrations: a single aggregate read for a multi-Commission Campaign;
a single Inbox read followed by one bulk steering request for its actionable set;
one Campaign submission containing multiple Commission contracts and dependencies;
and replay after response loss/restart without duplicate effects. Exercise partial
conflicts, authorization failures, changed-payload keys, concurrent human changes,
pagination during updates, expired cursors, and frozen mutation targets. Record MCP
call counts and request/response sizes alongside per-item outcomes. Fixtures establish
deterministic transport/state behavior, not live OpenCode or provider completion.

### Historical work packages — superseded M1–M6 sequence

The following retained detail preserves implementation guidance, prior rationale and
the meaning of historical evidence references. It is not a second executable plan:
use EH-C1–EH-C5 above for admission order, scope and next actions. In particular, old
M2 deployment timing and M1 Commission-to-merge breadth do not gate EH-C1. Reuse the
applicable technical steps under the Commission that now owns them.
Historical instructions to retain old clients mean a bounded migration period only;
the approved EH-13 amendment requires public Task API/tool deletion by EH-C4.

### M1 — Make one Commission observable end to end locally

First record existing provisioning, checkout, credential, Session-link and preview
behavior with the existing tests. Map batch/task/Attempt records onto the new domain
without destructive schema replacement or duplicate execution authority. Add only
the Campaign/Commission, obligation, instruction and report fields needed for one
Commission. Use additive SQLite migration and retain old clients or provide an
explicit compatibility adapter. Preserve existing pending effects during migration.

In core/reconcile/store, make ordinary turn completion leave the strategy Attempt
open. Construct the hierarchical instruction from durable facts and persist its
reason, source revision and dispatch identity before delivery. Install a minimal
reporting skill through existing Workspace bootstrap and ingest attributed reports
through an initial response adapter; this is not a final transport decision.

Drive the existing local OpenCode/test-model stack through Commission creation,
implementation, report, PR/check observations and merge. A fixture provider may
simulate GitHub here, clearly labelled as such. Add an HTTP projection and a minimal
working UI/CLI entry so the journey is usable before the full Ledger work. Show
that passing tests or a worker saying done do not finish the Commission, whereas
an authoritative registered-PR merge observation does. Capture the first correlated
trace now; telemetry is not a final milestone add-on.

### M2 — Select reporting transport and observe the slice in isolation

Use the pinned OpenCode runtime to test skill discovery and reporting during work,
not merely after a final response. Prototype the reporting tool beside the response
adapter. Bind actual Session/message/call identities to an admitted instruction;
never trust model-supplied Commission or provenance fields. Exercise omitted,
malformed, stale, foreign and duplicate reports, outage, restart and lost receipts.
Choose the simplest path that reliably captures intermediate claims and blockers;
record transcripts, latency and failure behavior here. If response parsing loses
necessary intermediate reports, retire it as the primary path rather than hiding
that gap. Update the selected contract in `docs/infra.md` and the installed skill.

Build immutable artifacts using existing Nix outputs. After explicit environment
approval, use dotfiles' reviewed procedure to deploy only this slice in isolation.
Run a small approved repository change through real checkout, model execution,
push, `integration:review`, required CI, approval and merge. Record image identities,
runtime versions, PR/check/merge identities and trace export. Confirm actual Session
links, live HTTP/WebSocket preview, credentials and shared-Nix behavior. If the
environment or external approval is unavailable, mark the milestone blocked; local
fixtures cannot substitute for this live evidence. Feed observed failures into M3.

### M3 — Converge safely across failures, waits and restarts

Extend the pure reconciliation table and durable effect executor, rather than adding
a second prompt loop. Periodic scans must recover missed events during both active
execution and idle waits. Dispatch rechecks revision, control mode, budget and active
instruction at a safe boundary. Deduplicate unchanged fact sets, serialize writers
and reconcile uncertain acknowledgements before any replay.

Add targeted failed-CI, challenged-claim, missing-deliverable and conflict directives.
Healthy CI/dependency/queue waits cause no model turns. Add a separate deterministic
watchdog with configurable recorded allowances: recover a stuck operation safely,
refresh lost context in the same Attempt, end an exhausted strategy, or request human
attention. A different strategy requires a reason and fresh Session, not the same
prompt repeated under a new ID. Aggregate usage survives all replacements. If there
is no defensible alternative strategy, escalate rather than fabricate one. Continue
observing external merge while held. Test crash windows using store failpoints and
restart against the same database and Workspace.

### M4 — Make interactive work and review round trips real

Add authorized, audited takeover/handback and obligation amendment/challenge commands
through the shared daemon API. Takeover serializes with dispatch; retain the exact
Session and preview. Defer routine testing, autonomous prompts and integration while
interactive, but permit explicitly requested checks. Inactivity and watchdog alerts
must never hand control back. Handback reobserves code, human decisions and deferred
work and resumes convergence without discarding UX changes.

Add stable obligation versions, evidence applicability and amendment history in
core/store. Modifications invalidate prior claims; removed obligations remain
auditable. Revision changes make old-code claims non-current. A reviewer challenge
records a reason and opens a repair gap without silently changing requirements.
Exercise the entire edit/preview/handback/repair/review journey with real OpenCode.

### M5 — Complete Campaign coordination and operator surfaces

Adapt scheduler admission to distinguish start gates from integration gates; default
dependencies allow parallel development. Validate missing references and cycles.
Before integration can advance, evaluate current dependencies and control state;
respect GitHub/Mergify as merge-policy authority and record externally merged facts
truthfully even if Anvil would have held its own integration action.

Use the shared HTTP projections and commands for MCP, `anvilctl` and Ledger UI.
Implement Focused Inbox versus Everything, Campaign relationships, review packets,
Commission inspector, exact Session/PR/ticket/preview links and interventions. Keep
work-complete/review-ready/integrated distinct. Match `docs/ui.html`'s information
hierarchy without treating sample data as runtime evidence. Test navigation and
interventions against the daemon, not just frontend component mocks. Optional
reviewer/verifier roles and cross-worker messages should reuse existing Session and
report contracts; their presence must not become a mandatory review stage.

### M6 — Evaluate and accept, then iterate from traces

Run the complete journey in the approved isolated deployment, including failure,
restart and interactive handback. Export redacted timelines joining observations,
decisions, instructions, effects, Candidates, reports and integrations. Include
latency, retries, model usage, prompt version/size and context transitions; unavailable
measurements must be labelled rather than invented.

Compare retained versus fresh-per-prompt autonomous Sessions on the same bounded
task set and model/runtime configuration, preserving Workspace, strategy and aggregate
budget. Record task count, repeated runs, confounders, failures, convergence, cost
and latency; make no general superiority claim from a single success. Verify fresh
Sessions discover the reporting skill. Keep interactive continuity outside this
experiment. Retain the baseline if results are inconclusive. Accept only after the
obligation ledger below has evidence or explicitly approved scope amendments.

## Concrete Steps

Commands below are proposed, not executed validation. Run from the repository root
in its Nix development environment. First reconcile the baseline:

    git status --short --branch
    git rev-parse HEAD
    git diff --stat
    git log -5 --oneline
    just --list

Record source revision plus relevant uncommitted diff, branch/PR and runtime version
before each evidence run. Implement one current Commission at a time, extending the existing
tests with the scenario names and assertions from the acceptance table. Then run:

    just build
    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo nextest run --workspace
    just frontend-check
    just security-check
    ANVIL_PREBUILT_BIN_DIR="$PWD/target/debug" ANVIL_E2E_TMPDIR=/tmp/opencode ANVIL_E2E_KEEP=1 just e2e
    ANVIL_PREBUILT_BIN_DIR="$PWD/target/debug" ANVIL_E2E_TMPDIR=/tmp/opencode ANVIL_E2E_KEEP=1 just e2e-ui
    git diff --check

Expected: all commands exit zero; test reports include the newly added positive and
negative harness cases. Preserve failures and actual test counts, not just the final
green summary. Confirm ports are free before E2E and use only its local credentials.
If build tools are missing, record the environment blocker rather than skipping gates.
For artifact-affecting milestones also run `nix flake check` and `just image` and
record output identities. `just docs` must serve the plan and specification links.

Do not invent deployment commands here. Prospective preparation may inspect the
dotfiles procedure and render proposed configuration only; render output must show
the isolated addrspace validation namespace alongside the pinned incumbent, with no
production overlay/image/ingress/PVC/secret mutation and no promotion. Record the
dotfiles revision and render evidence here. Render-only output is not deployment or
runtime validation. Before any live deployment, record explicit approval naming the
target, reviewed dotfiles revision/procedure, immutable image digest, independently
scoped credentials, bounded cost and bounded live scenario. Verify the rendered
diff is confined to the approved isolated namespace and does not modify production
overlays, images, ingress, PVCs or secrets. If any approval or verification is
missing, stop before applying anything. After approval, deployment evidence must
include the exact applied revision/image and runtime observations; do not claim it
from render output alone.
Before handoff rerun the relevant tests, fmt and workspace clippy and report results.

## Validation and Acceptance

These stable criteria implement the agreed spec. All rows are **unverified** at
plan creation. Record status, evidence references and residual gaps in this table
without changing normative criteria to match implementation.

The M1–M6 references in this historical ledger identify the original work packages,
not current Commission gates. Use the EH-C1–EH-C5 mappings above for execution;
partial Commission evidence does not establish the full cross-cutting EH criterion.

| ID | Required behavior and negative case | Required evidence / milestone |
| --- | --- | --- |
| EH-01 | Preserve checkout/bootstrap, profile access, scoped credential broker, shared Nix and HTTP/WebSocket preview; workers never receive controller secrets. | Existing regressions plus real isolated runtime observations; M1–M2. Unverified. |
| EH-02 | Durable Campaign/Commission owns obligations, branch/PR/optional ticket; turn end is not Attempt end. A new strategy starts a fresh Session; same-strategy recovery retains Workspace/history/aggregate budget. | Domain/store tests and correlated Session/restart trace; M1, M3. Unverified. |
| EH-03 | Hierarchical versioned instructions include current facts and reason-specific action, with reconstructed context for fresh Sessions and installed reporting skill. | Captured initial/repair/handback/recovery instructions and pinned-runtime skill-use observations; M1–M4. Unverified. |
| EH-04 | Periodic and event-driven reconciliation progresses after dropped events; active work is not raced, healthy waits use no extra model turns, unchanged failures do not repeat instructions, uncertain effects are reobserved. | Deterministic decision tests, effect-crash tests and runtime prompt-count trace across waits/restart; M3. Unverified. |
| EH-05 | Watchdog applies bounded deterministic recovery; stuck tools, repeated failures and exhausted budgets surface reasons; no retry invents a new strategy or resets spend. | Controlled stuck/failure/budget cases with recovery or Inbox outcome and no competing writer; M3. Unverified. |
| EH-06 | Interactive takeover serializes execution, retains preview/Session, suppresses routine autonomy/testing/integration; explicit checks work and only explicit handback restores autonomy. | Live UX edit/preview/handback/repair trace; long inactivity and watchdog negative tests; M4. Unverified. |
| EH-07 | Authorized obligation amendments retain audit history; modified/version-mismatched/old-Candidate evidence is non-current; reasoned challenges reopen gaps. Worker claims are not independent approval. | API authorization, applicability and audit tests plus runtime challenge/repair; M4. Unverified. |
| EH-08 | Reporting uses actual execution provenance, durable receipts and retry deduplication; foreign/malformed/stale reports are not silently accepted; omission stays a gap. Plugins never own autonomous prompting. | Pinned-runtime transport comparison including outage/lost receipt/intermediate progress; M2. Unverified. |
| EH-09 | Work complete, review ready and integrated are distinct; only authoritative merge of the registered PR into approved target finishes work, even while held; default label is integration:review. Approval identity is not an Anvil restriction. | Provider fixtures for wrong PR/target and stale checks plus real CI/review/merge record; M1–M3, M6. Unverified. |
| EH-10 | Dependencies default to parallel start/integration gating; explicit start gates block admission; invalid references/cycles are rejected. | Multi-Commission scheduler and integration tests plus observable Campaign gates; M5. Unverified. |
| EH-11 | HTTP, MCP, CLI and Ledger expose coherent work/actions; Focused/Everything, inspector/review packet, Campaign gates and exact external links work. | API/client tests and browser journey against real daemon, including unavailable/stale data; M5. Unverified. |
| EH-12 | Durable redacted export correlates decisions/waits, source facts, instructions/effects, revisions, latency/retries/usage and context changes; context-policy experiment does not reset budgets or interactive continuity. | Restart-persistent export, secret-redaction test and bounded comparative results with limitations; M1–M6. Unverified. |
| EH-13 | Campaign/Commission APIs and MCP support bounded set/aggregate reads, actionable Inbox reads, stable pagination/change cursors, single-request Campaign-with-Commissions orchestration and bulk steering/commands. Durable request/item idempotency, explicit concurrency preconditions and per-item outcomes prevent duplicate effects or stale overwrites after retries/restart. Delete public Task routes/tools; batch is an operation shape, not a competing work model. | EH-C1 submission/read foundations; EH-C2 evidence summaries; EH-C3 durable bulk execution; EH-C4 Inbox/bulk steering and Task API removal; EH-C5 end-to-end bounded-call demonstration. Exercise negative/recovery cases in Bulk interaction contract; record tool-call counts, payload sizes and remaining pagination. Unverified. |

Local fixtures prove deterministic behavior, not live GitHub, sandbox or model
behavior. Neither build success nor a worker completion claim accepts this campaign.
External approval, permissions and infrastructure gates remain authoritative. Stop
new costly work on exhausted approved budget, unknown effect outcome, suspected
credential exposure or uncertain production isolation. Preserve diagnostic evidence
and request the smallest missing decision; never weaken criteria silently.

## Idempotence and Recovery

Use additive, versioned schema changes and transactional command/report/effect
idempotency. Test migration against a disposable copy of representative old state;
retain an operator-approved backup before real migration. Do not down-migrate a live
database or run old binaries against an incompatible new schema. Recovery may require
restoring a matched database/binary pair after stopping writers and reconciling
external effects; restoring a database does not undo a pushed commit or merged PR.

Keep one execution authority per Commission during any legacy/new transition.
Duplicate events, reports and scans must be safe. On restart, inspect existing
Sessions, effects and external outcomes before issuing anything new. On missing
Session state, reconstruct the same strategy context without abandoning its branch.
On ambiguous push/PR/prompt result, observe before retrying; escalate if unresolved.

Prototype transport paths must be removable without dropping accepted reports or
changing obligation identities. Hold admission/dispatch for a troubled isolated
rollout, preserve state and logs, then use dotfiles' approved rollback. Cleanup must
target only resources created for the approved isolated run and must not delete
shared profile/Nix storage, production resources or unrelated user work.

## Artifacts and Notes

2026-11-08 local image-readiness evidence: on Anvil HEAD `db017c9` before
the documentation-only `d03af10` commit, from repository root `nix flake
check` exited 0 and
`nix build .#anvil-image .#anvil-sandbox-image .#anvil-nix-daemon-image --no-link`
exited 0. The resulting local store paths are Anvil
`/nix/store/ddwy2g0sssr5raawl8slgd1yz78nla5m-anvil.tar.gz`, sandbox
`/nix/store/97gfi052kdj8aja6nczwqylqp7snl17x-image-anvil-sandbox.json`,
and Nix daemon
`/nix/store/yvyzx77id9lq16qr08fh0l3w658yf91b-image-anvil-nix-daemon.json`.
Logs: `/tmp/opencode/anvil-db017c9-flake-check-20261108.log`,
`/tmp/opencode/anvil-db017c9-images-build-20261108.log`, and
`/tmp/opencode/anvil-db017c9-image-paths-20261108.log`. Nix emitted a
`system`-rename evaluation warning, not a failure. These are **local image
outputs**, not published image/registry digests; the JSON outputs' layer
digests are not substitutes. No image was loaded, pushed or deployed, and
the validation overlay still renders historical image tags. Since `d03af10`
changed only this plan, the executable source remains `db017c9`.

Manifest-only credential inventory for the selected real-model scenario:
`k8s/base/github-app-secret.yaml` is an empty placeholder. The incumbent
namespace's sealed credential contains the key names
`ANVIL_OPENCODE_SERVER_PASSWORD`, `ANVIL_GITHUB_APP_ID`,
`ANVIL_GITHUB_INSTALLATION_ID`, `ANVIL_GITHUB_PRIVATE_KEY` and
`ANVIL_SESSION_SIGNING_SECRET`; none is a model-provider key. A distinct
namespace-scoped Secret/App installation, a securely configured validation
profile with approved model credentials, independent profile/history/Nix
PVCs, validation-only controller and wildcard preview DNS/TLS/ingress and
reviewed SSO policy are still required. No credential values or cluster
readiness were inspected. Do not copy production SealedSecrets into the
proposal.

2026-11-08 render-only preparation (no EH acceptance): Anvil HEAD
`db017c932b05852ef4e0a903b5c0c4ff82c3509a` clean before this plan edit;
`gh pr status` reported no associated PR. The operator's dotfiles checkout at
`c456abb6fd60caad7443d1fe0688700cf7036d80` had unrelated dirty files;
it was not edited. A new, clean dotfiles worktree at
`/tmp/opencode/anvil-validation-dotfiles` carries the *local-only* commit
`b4fcdb0ea28e716827ce9588f9158c8bc65da0de` on
`feat/anvil-validation-render-only`. It adds only
`addrspace/apps/anvil-validation/{README.md,kustomization.yaml,runtime-config.patch.yaml,mcp-hosts.patch.yaml}`;
`addrspace/apps/kustomization.yaml` still excludes the proposal. From that
worktree `kubectl kustomize addrspace/apps/anvil` and
`kubectl kustomize addrspace/apps/anvil-validation` both exited 0, producing
`/tmp/opencode/anvil-validation-{incumbent,proposed}.yaml`. Parsing both with
`yq`/`jq` and evaluating `/tmp/opencode/anvil-validation-audit.jq` exited 0;
`/tmp/opencode/anvil-validation-audit.json` reports PASS: 23 incumbent and
19 validation resources, exactly `Namespace/anvil-validation`, all other
resources namespaced `anvil-validation`, three namespace-private PVCs and
namespace Role/RoleBinding, no Secret, SealedSecret, Certificate, Ingress,
secret data or ingress hosts. An independent read of the rendered JSON
confirmed no workload secret refs or old production host/namespace strings.
Rendered images are **historical tags**, not immutable digests or an approval.
No cluster diff, apply, PR merge, Flux registration, published image, live
runtime or model call occurred. Before a real rollout, prepare a new reviewed
dotfiles revision with the intended base, actual digest-pinned images,
independent credentials/storage/routing and bounded scenario; audit the entire
rendered diff and obtain explicit target/cost authority. Do not use this
deliberately nonfunctional overlay as-is.

2026-11-08 EH-C1 frontend increment, obligation mapping EH-C1-O2/O3 and
EH-01/EH-11/EH-13 (partial local UI/routing evidence only): starting branch
`anvil/incremental-roadmap`, HEAD `8d9ef4b1b55e1ea2639aeba00e43b3ae050c4376`,
ahead 13 of `origin/main`; `gh pr status` showed no associated PR. The initial
working tree already contained uncommitted Vite-to-Next migration edits and
untracked Next routes/components; those were preserved and completed. The
static export serves Campaign creation and aggregate/Commission reads, explicit
versioned start, and Session activity/attach/OpenCode navigation. Browser
fixtures cover changed-payload keys, 503 uncertainty versus definitive 422
rejection, unsafe preview URL rejection and stale Session navigation; they do
not exercise a real paid model, live preview, provider or merge. The old Vite
component tests were removed; the replacement is narrower, especially for
Session diagnostics, polling and end-to-end operator actions. No EH acceptance
row is promoted from this fixture evidence.

From repository root on the dirty frontend revision, `just build` exited 0,
workspace all-feature Clippy exited 0, `cargo nextest run --workspace` passed
**277 tests**, `just frontend-check` passed **6 tests**, and
`just security-check` exited 0; `cargo fmt --check` initially failed on
pre-existing `store/scheduler.rs:972` layout, corrected with rustfmt. Logs:
`/tmp/opencode/anvil-verification-*`. A later dirty-tree validation recorded
`just build`, fmt, Clippy, nextest (**278 passed**), frontend (**8 passed**),
security, Chromium browser test (**1 passed**) and local fixture E2E exiting
0 (`/tmp/opencode/anvil-verify-IVM3MSw2/`), but changes were staged and the
E2E smoke script corrected during this run, so it is not a single frozen-tree
acceptance record. The fixture is local-only.

Nix packaging exposed a real failed check: initial `nix build .#frontend
--no-link` exited 1 because the proposed npm dependency hash selected Next
15.5.6 while `web/package-lock.json` requested 15.5.29. Preserved diagnostics:
`/tmp/opencode/anvil-next-nix-verification/RESULTS.md`. Correcting both Nix
hash fields to the fake-hash build's actual
`sha256-Ggps6Vi7SpFUDmOSH6nmQUHd62mNTE7fhPJVkp545/s=` made
`nix build .#frontend --no-link` and
`nix build .#ci.x86_64-linux.verify.frontendTests --no-link` exit 0;
the latter checked exported HTML routes. `nix run .#sdlc -- changelog check`
also exited 0 (2 fragments). This is packaging evidence, not isolated runtime
validation. The implementation checkpoint was committed as
`4d1bf88f8eed05a8fb289a8c596a7d50ce77a2b4` on
`anvil/incremental-roadmap`; no PR or approved integration target is attached.
The final local rerun from repository root recorded `just build`,
`cargo fmt --check`,
`cargo clippy --workspace --all-targets --all-features -- -D warnings`,
`cargo nextest run --workspace` (**278 passed**), `just frontend-check`
(**8 passed**, export built), `just security-check`, `git diff --check`,
Chromium `npm run test:browser` from `web` (**1 passed**) and
`ANVIL_PREBUILT_BIN_DIR="$PWD/target/debug" ANVIL_E2E_TMPDIR=/tmp/opencode
just e2e-ui` all exiting 0. Logs:
`/tmp/opencode/anvil-verify-*.log`,
`/tmp/opencode/anvil-verify-final-*.log`,
`/tmp/opencode/anvil-verify-e2e-ui.log`. The staged diff fingerprint changed
during the run (Nix hash correction and implementation commit), so this is a
sequence of successful local checks, not a single frozen-tree acceptance run;
the Nix frontend and CI frontend derivation were independently verified with
the final hash. No external integration, live isolation or EH acceptance is
inferred from these local checks.

2026-11-08 00:03Z EH-C1 checkpoint, source HEAD `a4d36658a81001c572174906b96b6efe40f0eb92`
plus uncommitted core/daemon/store/MCP/test/plan changes; `node_modules/` was
pre-existing and remains untracked. All commands below ran from repository root.
The initial `just build` exited 0; `cargo fmt --check`,
`cargo clippy --workspace --all-targets --all-features -- -D warnings`,
`cargo nextest run --workspace` (262 passed, 0 failed, 1 slow),
`just frontend-check` (16 passed), `just security-check`, and
`git diff --check` exited 0 at that dirty checkpoint. Full validation logs:
`/tmp/opencode/anvil-verification-*.log`. Npm reported two high-severity
dependency findings, without a failing command; no dependency remediation
was attempted. Subsequent source edits require a final rerun before handoff.

| Obligation / mapped acceptance | Local evidence and present gap |
| --- | --- |
| EH-C1-O1 / EH-02 | `crates/anvil-core/src/lib.rs` validates Campaign/Commission/obligation graph; migration v15 and atomic store adapter in `crates/anvild/src/store.rs` preserve old records; `store/scheduler.rs` retains strategy Attempt after a turn. Store/restart and API tests are deterministic only. No authoritative integrated lifecycle demonstrated. |
| EH-C1-O2 / EH-01, EH-10 | Explicit versioned start and capacity/start gates reuse the existing scheduler; `tests/local-e2e.sh` uses local Workspace, branch, bound Session and scripted worker. Existing security and E2E fixtures cover regressions, **not** live Kubernetes, broker, shared Nix or preview observations; start-dependent completion remains unresolved. |
| EH-C1-O3 / EH-03, EH-09, EH-11, EH-12, EH-13 | One-request idempotent Campaign graph, HTTP/MCP aggregate page and instruction envelope are implemented; local scripted worker edited `target.txt` on an Anvil branch. No worker commit/push/PR, real model skill discovery, correlated full trace export, or live GitHub evidence. Page cursor covers immutable membership only; public change watermark is separate. |
| EH-C1-O4 / EH-02, EH-04, EH-05 | Store-derived measured Attempt count persists across reopen; elapsed execution and model cost remain unavailable unless recorded. Fixture after branch edit restarts controller, retaining one Attempt/Session and diff. Unknown prompt outcome is not replayed. This does not prove recovery of a submitted-but-unobserved prompt, safe multi-Attempt branch continuity or all budget limits. |

Two useful failed local runs are preserved: `/tmp/opencode/anvil-local-e2e-campaign-20261107-152527.log`
(worker edit while Session unbound), `/tmp/opencode/eh-c1-e2e-rerun.log`
(v2 synchronous prompt and early restart), and
`/tmp/opencode/eh-c1-e2e-async.log` (restart before fixture model input).
Each `just e2e` exited 1. After changing fixture ordering, the same command
`ANVIL_PREBUILT_BIN_DIR="$PWD/target/debug" ANVIL_E2E_TMPDIR=/tmp/opencode ANVIL_E2E_KEEP=1 just e2e`
exited 0 (delegate report); it observes the branch edit before restart and
preserves identity with one Attempt, not a completed PR or unknown-effect replay.
No paid model, external repository mutation or deployment was used.

2026-11-08 subsequent review/verification correction: review against the
post-fix source exposed a nullable `batch_id` lookup in `tasks_for_session` that
made the initial Commission prompt fail before submitting a run. An E2E run
after the prior green unit suite exited 1 and left a ready idle Session and
provisioning Attempt, with no model request. Diagnostic artifact:
`/tmp/opencode/eh-c1-final-validation.log`, fixture
`/tmp/opencode/anvil-local-e2e.6t0kCN`. The Session-to-Commission classifier
now uses bound Attempts; the historical session-to-Batch reader accepts null
membership. Pre-submission failures persist an explicit failure only when
the durable run record proves no submission; submitted/unknown outcomes still
require observation. The later read-only reviewer attempt reached its step
limit; its apparent sibling-instruction and double-dispatch concerns were
checked against `campaign_work_instruction` (uses Campaign purpose/contracts,
not sibling page) and the serialized prompt-worker guard. It did identify a
legacy recovered-sandbox state regression, repaired in the small integration
edit. The reviewer API key had first expired; a subsequent invocation did run.

Latest validation on HEAD `a4d3665` plus dirty EH-C1 changes from repository
root: `just build`, `cargo fmt --check`,
`cargo clippy --workspace --all-targets --all-features -- -D warnings`,
`cargo nextest run --workspace` (**269 passed, 0 skipped**),
`git diff --check`, `bash -n tests/local-e2e.sh`, and
`ANVIL_PREBUILT_BIN_DIR="$PWD/target/debug" ANVIL_E2E_TMPDIR=/tmp/opencode ANVIL_E2E_KEEP=1 just e2e`
all exited 0. Full logs: `/tmp/opencode/eh-c1-gates-latest.log`. The
scripted-model fixture used Campaign `f4bcb5bc-a5cb-44ec-8486-04e0837241d7`,
Commission/Task `024bbf17-c1b8-4463-924b-5e71a2e25779`, and Session
`campaign-e2e-5c641f39`; it observed the edit/diff on the branch before
restart, then stable identities and one Attempt afterward. `just frontend-check`
(16 tests) and `just security-check` also exited 0 in the preceding full
verification run; those were not repeated after the final Rust changes.
These are deterministic local fixtures, not real provider/cluster integration.

2026-11-08 EH-C1 local deployment-readiness follow-up (HEAD `39f0efa`, then
dirty implementation), mapped evidence and limits:

| Obligation / acceptance | New local evidence and remaining limit |
| --- | --- |
| EH-C1-O1 / EH-02 | Durable Commission start now records a stable keyed receipt, initial version and current projection; unchanged replay after restart returns the original receipt, changed payload or stale distinct command conflicts. `crates/anvild/src/store.rs`, `crates/anvild/src/campaign.rs`, HTTP and MCP tests. No integrated lifecycle claimed. |
| EH-C1-O2 / EH-01, EH-10 | Three-Commission deterministic graph test exercises atomic acceptance, explicit start, integration-only parallel admission, start-after block, capacity-one scheduling and restart-stable pages. Unattached legacy Task admission is explicitly held and migrated additively in v16 rather than silently executing an empty prompt. Fixture Git/worker path does not establish Kubernetes, scoped broker, shared Nix or preview. |
| EH-C1-O3 / EH-03, EH-09, EH-11–EH-13 | `tests/local-e2e.sh` and `crates/anvil-test-model` now exercise actual OpenCode edit, shell test, commit and push to a disposable HTTPS bare repository; the worker POSTs one PR record to loopback `tests/git-http-fixture.mjs`. Fixture PR provider is `local-fixture-not-github`, **not** a live GitHub PR or authoritative merge. Recorded successful local run in `/tmp/opencode/eh-c1-readiness-final.log`: branch `anvil/campaign-e2e-19a31206`, commit `54fde2e22b44f697335542144757c84767d4ce77`, PR `local-pr-1`; start replay 200 and changed-key payload conflict 409 after controller restart, with no second Attempt, Session or PR. |
| EH-C1-O4 / EH-02, EH-04, EH-05 | Separate local crash-window Commission holds one actual model request across controller restart after durable Submitted; request count remains **1→1** across scheduler ticks and Attempt/Session/run identities stay stable. An unknown outcome is not equated with success or replayed. `attempt_elapsed_ms` is wall-clock, not model execution; `execution_ms`, tokens and cost remain explicitly unavailable and their budgets unenforced. |

Preserved failed fixture diagnostics: `/tmp/opencode/anvil-local-e2e.lmYrEg`
(pre-integration HTTP start mismatch), `/tmp/opencode/anvil-local-e2e.Yq58bs`
(scripted model's wrong `bash` tool), `/tmp/opencode/anvil-local-e2e.5Bkfen`
(incorrect assertion on nested receipt), `/tmp/opencode/eh-c1-delivery-green-attempt.log`
(standalone Task raced legacy scheduler), `/tmp/opencode/eh-c1-crash-window-attempt.log`
(restart before model request), and `/tmp/anvil-local-e2e.WGBKqS`
(fast turn ended before Attempt entered running). These are failed runs, not
acceptance; fixes and subsequent passing checks are described above. On the
dirty pre-v16 revision `/tmp/opencode/eh-c1-readiness-final.log` records
`just build`, fmt, full workspace Clippy, nextest **274 passed, 0 skipped**,
frontend **16 passed**, security, syntax, diff and prebuilt E2E exiting 0.
Npm reported two high-severity vulnerabilities; they were not silently
remediated. After the v16 detached-Task safety fix, the full validation must
be rerun and recorded separately. The prescribed build may recreate ignored
`web/node_modules/`; prune it again at handoff under the operator's approval.

2026-11-08 04:21Z post-v16 validation correction: the first workspace nextest
run after the migration exited 100 with `169 passed, 1 failed, 102 not run`:
`task_page_applies_lifecycle_runnable_and_external_filters_before_pagination`
still expected a now-held detached Task to appear runnable (diagnostics
`/tmp/opencode/eh-c1-readiness-migration.log`). The test now asserts the hold
and versioned transfer before runnable projection. Subsequent checks from
repository root on HEAD `39f0efa` plus uncommitted EH-C1 changes all exited 0:
`just build`; `cargo fmt --check`;
`cargo clippy --workspace --all-targets --all-features -- -D warnings`;
`cargo nextest run --workspace` (**276 passed, 0 skipped**);
`just frontend-check` (**16 tests passed**); `just security-check`;
`git diff --check`; `bash -n tests/local-e2e.sh`;
`node --check tests/git-http-fixture.mjs`; and after a free-port check,
`ANVIL_PREBUILT_BIN_DIR="$PWD/target/debug" ANVIL_E2E_TMPDIR=/tmp/opencode ANVIL_E2E_KEEP=1 just e2e`
(31 seconds). Full log: `/tmp/opencode/eh-c1-readiness-v16-final.log`.
Fixture worker branch `anvil/campaign-e2e-14994016`, commit
`67aee37c21655a6b4fd2426951794ee5d763cd1a`, local PR `local-pr-1`;
the separate held submitted-run fixture counted model requests **1→1**, one
Attempt, and did not replay the unknown outcome. No real GitHub/Kubernetes,
paid model or external repository was involved. `rm -rf -- node_modules
web/node_modules` exited 0 after validation; neither directory exists at
this checkpoint. Npm still reports two high-severity audit findings.

Final read-only review found the detached-Task silent queue issue resolved by
the held migration and confirmed start receipt/no-replay fixture boundaries.
Its bounded residual observation: v16 directly updates the change projection
and does not upsert a missing materialization row or prune migration-appended
changes; representative old-state migration tests pass but the missing-row
case was not exercised. This does not certify a live database migration;
retain backup and matched binary/DB recovery rules before deployment. Safe
completion/integration of a start-dependent upstream Commission and measured
time/cost enforcement remain outside this local proof. No PR/approved target,
external cost budget or isolated deployment procedure was granted.

2026-11-08 local follow-up commit binding: implementation and evidence above
committed as `2341e3521fa4a17785b6b2689cd9df0aa191055d` on
`anvil/incremental-roadmap`; `git status --short --branch` showed no tracked
modifications and no untracked `node_modules/`. This final documentation-only
binding records the source revision of the preceding successful dirty-tree
verification; it is not a new runtime validation or integration claim.

2026-11-08 commit binding: the validated local increment was committed as
`8ef0a1829b130425839d8fa0e1239aebfa1dbce1` on
`anvil/incremental-roadmap`; `git status --short --branch` afterward showed no
tracked modifications. **Correction:** a subsequent explicit `test -d
node_modules` found that the pre-existing untracked root `node_modules/` is
absent (while ignored `web/node_modules/` exists). The exact removal point
and prior directory contents were not captured. Do not claim it was preserved
or recreate it destructively without confirming what was there; notify the
operator. No tracked user changes were present at the start.
There is still no registered PR or approved integration target. This record
update is documentation-only and is not a new validation of runtime behavior.

Read-only reviews identified and prompted fixes for capacity after turn-end,
unknown submitted effects, branch mismatch, stale start preconditions and a
Kubernetes runtime-only nil-run panic. Review also identifies residual risks:
Commission retry currently uses a fresh Session-derived branch rather than
reusing the existing Workspace branch; start dependencies need an explicit
upstream milestone beyond a mere turn end; time/cost budgets are not enforced
and live Kubernetes runtime-only behavior remains unobserved. Do not admit
unapproved external work on this partial evidence.

2026-11-07 API-amendment validation: documentation-only changes to this plan on the
same `637af464d3e86df9d11a0ef8222edbe894ce9b02` code baseline. From the repository
root, `cargo fmt --check`, workspace clippy with all targets/features and `-D warnings`,
and `git diff --check` exited 0. No runtime tests were run; EH-13 remains unverified.
The pre-existing untracked `node_modules/` was not modified by this revision.

2026-11-07 Commission-planning revision validation: baseline
`637af464d3e86df9d11a0ef8222edbe894ce9b02`, with only this tracked plan modified
and pre-existing untracked `node_modules/` left untouched. From the repository root,
`cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`
and `git diff --check` exited 0. No executable code changed; runtime/test suites were
not run and no Commission acceptance, deployment or external mutation is claimed.

Planning evidence: inspected `PLANS.md`, `docs/infra.md`, `justfile`, daemon/store
entry points, frontend layout, local E2E startup and OpenCode pin on 2026-11-06.
No build, runtime or acceptance results have been collected for this plan.

2026-11-06 implementation baseline: branch `anvil/incremental-roadmap`, HEAD
`3aa874442f96acc44e554657aa87509671264005`, ahead 2 of `origin/main`; no PR is
recorded. `git status --short --branch` showed only pre-existing untracked
`node_modules/`, left untouched. `cargo test -p anvil-core -p anvil-reconcile -p
anvild --lib` compiled and reported 40 core and 42 reconcile tests passing; anvild
was still running at timeout 120s, with `store::tests::retained_change_limit_resets_expired_cursors_across_restart`
reported running over 60s. This is a timed-out run, not a passing suite.

After the M1 skill-bootstrap change, `cargo test -p anvild --lib
workspace_bootstrap_installs_anvil_reporting_skill` passed (1 test; 143 filtered)
and `cargo fmt --check` exited 0. The change has not yet been checked in a full
workspace build, clippy, full test suite, frontend checks, or E2E. Reporting transport
and runtime skill discovery remain unverified.

2026-11-06 implementation follow-up, revision `9499fc7` (skill-bootstrap commit):
`just build` exited 0, including frontend production build and `cargo build
--workspace`. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
exited 0; `cargo fmt --check`, `git diff --check`, and `just frontend-check` exited
0 (16 frontend unit tests; Vite production build passed). `cargo nextest run
--workspace` first hit its 120-second command timeout after 251/252 tests had passed;
the remaining slow retention/restart test was terminated. Re-running with a 360-second
timeout exited 0: 252 tests passed, 0 failed, 1 slow (93.359 seconds). `just build`
and frontend checks reported 2 high-severity npm audit findings; dependency files
were not changed. These are regression/build checks only: no Commission journey,
OpenCode skill discovery, reporting transport, GitHub merge, or E2E evidence has
been collected. The untracked `node_modules/` remains untouched by cleanup.

Follow-up on the same dirty revision: `cargo test -p anvil-core -p anvil-reconcile
-p anvild --lib` exited 0 (40 + 42 + 144 = 226 tests passed; 0 failed, 91 seconds).
The earlier 120-second timeout was only a timeout, not a test failure. Workspace
`cargo clippy --workspace --all-targets --all-features -- -D warnings` and
`cargo fmt --check` exited 0. `just frontend-check` exited 0: 16 frontend unit tests
passed and Vite production build succeeded. npm reported 2 high severity dependency
vulnerabilities; no dependency changes were made. The frontend recipe ran `npm ci`
against the already-untracked `node_modules/` directory; that directory remains
untracked and was not cleaned up. `just security-check` and `git diff --check` exited
0. Workspace build, full workspace tests and E2E remain to be run; the focused unit
run does not establish any live OpenCode or GitHub behavior.

For each executed run append here: UTC time, obligation IDs, revision/dirty baseline,
exact command and working directory, exit status, test counts or trace IDs, actual
versus expected behavior and residual gap. Store large redacted artifacts at a named
durable location and link them here; do not create a second acceptance ledger. Keep
failed observations and append corrections rather than replacing historical results.

## Interfaces and Dependencies

EH-C1 provisional public interface (2026-11-08): `POST /v1/campaigns` requires
`Idempotency-Key` and accepts `{campaign:{purpose,shared_contracts},
commissions:[{local_key,objective,obligations,execution_target,budget,
start_after,integration_after}]}`; returns `{campaign_id,commissions:[{local_key,
commission_id}],receipt}` with 201 created, 200 replay or 409 changed-key
conflict. `GET /v1/campaigns/:id?after=<local_key>&limit=1..256` returns an
immutable-membership keyset page, `total` and `next_page_cursor` (null when
exhausted); `GET /v1/commissions/:id` projects Task-backed lifecycle, bound
Attempts and measured/unavailable usage. `POST /v1/commissions/:id/start` takes
`{expected_version}`; stale versions conflict. MCP tools
`anvil_submit_campaign`, `anvil_get_campaign`, `anvil_get_commission`, and
`anvil_start_commission` each forward one corresponding application request.
The page cursor is not a change watermark; full query-scoped change recovery,
bounded set steering and per-item receipts remain EH-C3/EH-C4 work. There is
currently no committed PR or approved integration target for this interface.

Operator-approved interface direction (2026-11-07): expose Campaign/Commission
bulk application operations with durable idempotency and receipts, aggregate queries,
cursor pagination/change tracking and concurrency preconditions. Retire public Task
routes and MCP tools by EH-C4; update CLI/UI/MCP consumers in the same Commission.
Do not retain Batch/Task as a second public work hierarchy or implement bulk MCP as
a requirement for client-side per-item loops. Existing transactional idempotency,
change streams and cursor-reset behavior are useful implementation primitives to
adapt rather than discard. Historical migration readers may remain without exposing
Task commands. Exact new route/tool schemas are to be recorded here during EH-C1.

Reuse core domain types, pure reconciliation snapshots/decisions, transactional
SQLite store/effect ledger, existing HTTP authority, OpenCode adapter, GitHub observer
and router interfaces. Extend them at the milestone that needs the behavior; do not
prescribe a new generalized event bus, orchestration DSL or replacement platform.
Record concrete new route/type/signature contracts here when implementation selects
them, and reflect enduring component contracts in `docs/infra.md`.

M1 execution-state adapter: `ControllerStore::set_attempt_turn_completed(attempt_id)`
is the Reconciler-only durable transition for an ordinary completed OpenCode turn.
It leaves the strategy Attempt lifecycle running and marks the turn completed; it
does not complete the Task/Commission. The legacy scheduler continues to use
`set_attempt_state(..., "completed")` and its existing compatibility completion
bridge. Starting a subsequent turn clears the prior `turn_state`.

The reporting boundary must resolve authenticated execution identity to instruction,
Attempt and Commission, accept versioned Candidate-bound claims, and return a durable
receipt or explicit error. All client commands share authorization/audit semantics.
Provider observations retain their own identity, revision and timestamp; GitHub and
Mergify remain authoritative for checks, approval and merge. Agent Sandbox, profile,
Nix and credential roles retain the infrastructure contracts already specified.

Revision note — 2026-11-06: initial plan, requested after agreement on the controller
spec; prioritizes an incremental deployed vertical slice over another rewrite.

Revision note — 2026-11-07 API amendment: recorded the operator's explicit Task API
deletion requirement and set-oriented Campaign/Commission interaction contract. Added
EH-13, refined each Commission's existing obligations and set public Task retirement
at EH-C4. Batch queries/commands, durable request/item idempotency, cursor recovery,
concurrency checks and single-request Campaign orchestration are delivery requirements,
not optional performance optimizations. No implementation acceptance is claimed.

Revision note — 2026-11-07: at the operator's request, persisted Campaign EH and five
sequential Commission contracts with stable grouped obligation IDs, demonstrations,
integration start gates and evidence mappings. Replaced the active six-milestone
sequence while retaining its technical detail as historical work packages. Preserved
EH-01–EH-12 criteria, prior results, external authority constraints and the requirement
for an explicit amendment before reducing existing acceptance scope. No implementation
or runtime acceptance is claimed by this documentation revision.

Implementation note — 2026-11-06: M1 began with the installed reporting skill in
the existing Workspace bootstrap. No Commission data model or end-to-end journey is
claimed yet; preserve the baseline session navigation and execution authority while
choosing those interfaces.

Execution note — 2026-11-07: reconciled the checkout before continuing. The prior
bootstrap implementation and verification commits are present at HEAD; `node_modules/`
is pre-existing user data and must not be cleaned up. Continue M1 from this revision.

Execution evidence — 2026-11-07, implementation revision based on `a9062b9`
(working tree changes to `crates/anvild/src/lib.rs`, `store.rs`, and
`store/scheduler.rs`; pre-existing untracked `node_modules/` unchanged):

- `cargo test -p anvild --lib completed` from the repository root exited 0: 5
  matching tests passed, including the 2 new turn/Attempt lifecycle cases. The
  subsequent full `cargo test -p anvild --lib` exited 0: 146 passed, 0 failed,
  92.74 seconds. Expected state is confirmed in the durable attempt payload; no
  end-to-end Commission journey or report provenance was exercised.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` exited 0.
- `cargo fmt --check` and `git diff --check` exited 0 after formatting. The initial
  targeted test command supplied two positional filters, which Cargo rejected; rerun
  with the shared `completed` filter passed. The initial format check found only
  rustfmt layout differences, corrected before final validation.
- No frontend, workspace build, full workspace test, E2E, OpenCode runtime, provider,
  deployment, or external repository test was run for this increment. No model spend
  or external mutation occurred.
