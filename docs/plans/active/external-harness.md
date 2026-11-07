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

This request authorizes drafting the plan, not executing it. Implementation requires
approval to proceed. Deployment, model spend and mutations to external repositories
require an approved target and budget. Isolated deployment and production protection
are governed in dotfiles; do not run the repository's generic deploy/cleanup recipes
against an assumed environment. Production promotion is outside this campaign.

## Progress

- [x] (2026-11-06) Drafted this plan from the agreed spec and inspected mainline entry points; no implementation evidence claimed.
- [ ] M1: Preserve mainline behavior and deliver one local Commission-to-merge vertical slice. (in progress; reporting skill bootstrap only)
- [ ] M2: Exercise reporting transport on pinned OpenCode and deploy the slice to an approved isolated environment.
- [ ] M3: Complete deterministic convergence, restart recovery and watchdog behavior.
- [ ] M4: Deliver interactive control, obligation amendments and evidence challenges.
- [ ] M5: Deliver Campaign dependencies and coherent API/MCP/CLI/Ledger surfaces.
- [ ] M6: Evaluate context policy and accept the complete runtime journey with exportable evidence.

## Surprises & Discoveries

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

Implementation is authorized by the operator's request. M1 has started with a
small Workspace-bootstrap change: the Kubernetes Sandbox init container now installs
`.opencode/skills/anvil-reporting/SKILL.md` into the project Workspace. The skill
defines progress, obligation-claim, artifact and blocker reporting and explicitly
distinguishes claims from integration. This is guidance only; durable attributed
report ingestion and the Commission-to-merge journey are not implemented by this
change. All acceptance rows remain unverified. No deployment, model spend, external
repository mutation, or dotfiles change has been made. Continue M1 locally; stop
before M2's isolated deployment gate until its target and budget are approved.

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
before each evidence run. Implement one milestone at a time, extending the existing
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

Do not invent deployment commands here. Before M2, record the approved dotfiles
revision/procedure, isolated target, immutable images, cost limit and bounded live
scenario in Artifacts and Notes. If any is missing, stop at that external gate.
Before handoff rerun the relevant tests, fmt and workspace clippy and report results.

## Validation and Acceptance

These stable criteria implement the agreed spec. All rows are **unverified** at
plan creation. Record status, evidence references and residual gaps in this table
without changing normative criteria to match implementation.

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

Reuse core domain types, pure reconciliation snapshots/decisions, transactional
SQLite store/effect ledger, existing HTTP authority, OpenCode adapter, GitHub observer
and router interfaces. Extend them at the milestone that needs the behavior; do not
prescribe a new generalized event bus, orchestration DSL or replacement platform.
Record concrete new route/type/signature contracts here when implementation selects
them, and reflect enduring component contracts in `docs/infra.md`.

The reporting boundary must resolve authenticated execution identity to instruction,
Attempt and Commission, accept versioned Candidate-bound claims, and return a durable
receipt or explicit error. All client commands share authorization/audit semantics.
Provider observations retain their own identity, revision and timestamp; GitHub and
Mergify remain authoritative for checks, approval and merge. Agent Sandbox, profile,
Nix and credential roles retain the infrastructure contracts already specified.

Revision note — 2026-11-06: initial plan, requested after agreement on the controller
spec; prioritizes an incremental deployed vertical slice over another rewrite.

Implementation note — 2026-11-06: M1 began with the installed reporting skill in
the existing Workspace bootstrap. No Commission data model or end-to-end journey is
claimed yet; preserve the baseline session navigation and execution authority while
choosing those interfaces.
