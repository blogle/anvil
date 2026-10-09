# Deterministic Orchestration and Reconciliation

## Status

Canonical specification for Anvil's deterministic task-convergence controller. Revised 2026-10-08 for complete decision inputs, stable action intent, shadow cutover, OpenCode ambiguity, and observer correctness. This supersedes older batch-supervision designs where they conflict.

## Objective

Build the deterministic control loop that advances accepted Anvil Tasks toward their declared completion policies without ChatGPT or a human babysitting OpenCode sessions.

The first shippable reconciler must autonomously handle the common delivery loop:

```text
Task runnable
→ implementation Attempt
→ worker turn
→ Git/workspace observation
→ Pull Request observation
→ CI failure
→ same Attempt receives repair continuation
→ CI becomes healthy
→ external integration occurs
→ merged delivery observed
→ completion policy satisfied
→ Task terminal
→ runtime garbage-collected
```

External reality is nondeterministic.

The controller decision is deterministic:

> For the same serialized TaskSnapshot and logical time, reconciliation must produce the same ordered Action set.

## Milestones and implementation order

This document defines the eventual system, but only R1 is first-wave. Track R1 under ANVIL-56, with three independently reviewable integration slices **not** separate top-level Lific tickets:

- **R1a kernel:** complete TaskSnapshot contract from the companion Task spec, pure reconciler, logical time, stable action-intent comparison, replay, durable outbox/fencing and tests. Freeze adapter interfaces here.
- **R1b adapters:** GitHub polling/check semantics and in-process/local protocol fakes; `anvil-test-world`; OpenCode SendTurn acceptance/idempotency spike. R1b may begin in parallel after R1a interfaces are frozen.
- **R1c convergence:** CI repair, no-progress/attention, terminal/GC, observer scheduling, named failpoints/crash recovery, and recursive offline factory E2E.

Do **not** grant autonomous production authority until both the SendTurn ambiguity gate and Legacy→Shadow→Reconciler cutover have passed.

R2 adds GitHub webhooks/inbox/wakeups; polling remains correctness authority. R3 adds independent verification and holdouts. R4 adds Lific queue adapter. R5 adds shared infrastructure incidents. None belongs in R1 unless needed to correct an R1 invariant.

## Architecture

```text
Desired work
    │
    ▼
 Durable Task
    │
    ▼
TaskSnapshot ────────────────┐
                             │
logical time ────────────────┤
                             ▼
                        reconcile()
                             │
                             ▼
                       ordered Actions
                             │
                             ▼
                    durable Action outbox
                             │
                   ┌─────────┴──────────┐
                   ▼                    ▼
              Execution              External
               adapters              adapters
                   │                    │
                   └──── observations ──┘
                             │
                             ▼
                        next snapshot
```

The reconciler does not call GitHub, Kubernetes, OpenCode, Lific, or the filesystem directly.

Adapters normalize external reality into Task facts and execute typed Actions.

## Facts versus claims

| Information | Authoritative source |
|---|---|
| Sandbox/runtime existence | Execution adapter |
| Sandbox/platform health | Platform/Execution adapter |
| OpenCode turn submitted/running/completed/failed | Runtime adapter |
| Workspace HEAD/dirty state | Workspace observer |
| Branch existence/head | Git/CodeHost adapter |
| Pull Request number/head/state | CodeHost adapter |
| CI/check status | CodeHost adapter |
| Review state | CodeHost adapter |
| Merge state | CodeHost adapter |
| Imported Lific content | WorkSource adapter |
| Worker blocker/question | Agent claim |
| Verifier verdict | Agent claim |
| Worker says “done” | Agent claim; never authoritative |
| Transcript prose | Never authoritative |
| Task Completed | Reconciler evaluating immutable completion policy against trusted evidence |

Agent claims may block work or trigger investigation. They may not create trusted completion evidence.

## Durable reconcile decision, canonical hashing, and replay

Use **the canonical TaskSnapshot defined in `durable-task-primitive.md`**; do not create a parallel snapshot type. It contains action-history summary, budget usage, retry deadlines, controller mode, operator hold, generation, delivery/branch binding, facts, attempts, blockers, dependencies.

```rust
struct ReconcileDecision {
    schema_version: u32,
    reconciler_version: String, // exact logical evaluator version
    task_id: TaskId,
    task_version: u64,
    generation: u64,
    logical_time: LogicalTime,
    snapshot_json: Value,       // complete exact evaluated input
    snapshot_hash: Hash,       // excludes logical_time and volatile collection metadata
    actions_json: Value,       // deterministic ordered desired Actions
    actions_hash: Hash,
    rule_id: String,           // stable chosen decision row/reason
    created_at: Timestamp,
}
```

Canonical serialization sorts keys, set-like vectors, dependency lists, relevant action history, and other unordered collections. Do not hash Rust `HashMap` iteration order.

**Semantic snapshot hash** excludes `logical_time`, `recorded_at` and other collection-only churn; action eligibility still evaluates logical time against persisted deadlines.

A periodic wake does **not** necessarily commit a decision. Persist when the semantic snapshot hash changes, an action-intent set changes, or a previously recorded deadline becomes due. In the absence of meaningful new input/action/deadline, reuse the prior decision. An unchanged snapshot may still yield a different action set after a due time; that must be recorded.

**Replay:** `reconcile(snapshot_json, stored_logical_time, stored_reconciler_version)` must reproduce `actions_json` and `rule_id`. CI retains versioned golden traces. Intentional changes to logic require reviewed golden fixture updates rather than claiming old traces match the new binary. A missing old evaluator version is reported as unsupported replay version, not silently reinterpreted.

Expose `GET /v1/tasks/{id}/decisions` with cursors, rule IDs, snapshot/action hashes and detail expansion.

## Logical time

Do not use `Instant` inside reconciliation logic.

Use a serializable newtype:

```rust
struct LogicalTime(i64);
```

Wall-clock acquisition occurs outside the pure reconciler.

Retry deadlines, stale observations, and wall-clock budgets are evaluated relative to the supplied logical time.

## Single-flight, stable desired-action sets, and fencing

Use an in-process per-Task single-flight key plus transactional CAS on the task/reconcile generation. The lock improves efficiency; CAS is the durability guarantee.

**Two counters must not be conflated:** a recorded-decision sequence for audit and a **desired-action generation** for the authorization state. Repeated polls and unchanged input must not continuously increment the action generation or cancel pending work.

On meaningful decision change, atomically compare new desired Action keys to active outbox keys and commit the snapshot, rule and resulting action-intent delta with CAS on the generation read:
- Insert desired Actions using unique `idempotency_key` with insert-or-ignore / replay of existing authoritative row.
- Retain prior pending/executing Actions whose keys are still desired.
- Supersede only pending/unclaimed Actions whose keys are no longer desired.
- An executing external request cannot be retroactively retracted. Record `UnknownOutcome` as needed and reconcile by observation.
- An executor transactionally claims an Action and verifies its key remains authorized by the Task's current desired-action set, controller mode, and hold state immediately before starting side effects.
- Never allow a newer no-op periodic sweep to revoke an otherwise valid in-flight Action.

Actions are protected against concurrency and stale intent, not promised exactly-once execution at an unreliable external API boundary.

## Pure reconciler

Conceptually:

```rust
fn reconcile(
    snapshot: &TaskSnapshot,
    now: LogicalTime,
) -> Vec<Action>;
```

It:

- performs no I/O;
- mutates no database;
- generates no random identifiers;
- reads no wall clock;
- invokes no model;
- uses only snapshot + logical time.

Action ordering is deterministic.

## Explicit total-order reconciliation rules

Use one exhaustive, table-driven decision reducer with stable `rule_id` values. The following priorities are normative (terminal cleanup may still run while held):

1. **Already terminal:** observe/cleanup safely, never dispatch implementation.
2. **Completion policy satisfied:** commit completion from *fresh trusted* evidence, even when operator-held. Suppress destructive GC while held.
3. **Controller mode Legacy or Shadow:** no automatic side effects. Shadow records nonexecuted decisions for comparison/replay.
4. **Operator hold / unresolved blocker:** continue passive observation; stop autonomous work.
5. **Unrecoverable delivery:** PR closed unmerged, branch missing, unexpected force-push/unbound head, or changes-requested review → structured attention in R1. Do not blindly create a new PR or override reviewers.
6. **Budget exhausted:** stay Open, `needs_budget` attention. Accept an audited `BudgetGrant` or explicit give-up; no unbounded retries.
7. **Retry backoff pending:** do nothing until durable due time.
8. **Platform/runtime failure:** bounded recovery based on factual health; never treat provider unavailability as runtime absence.
9. **Active turn running/submitted:** observe only, no new SendTurn.
10. **Known CI failure:** one `ChecksFailed` continuation for current head/cause, subject to no-progress and budget rules.
11. **Completed continuation made no progress:** same head/worktree and same failure → `no_progress` attention, not silence or infinite repeat.
12. **Verification rejection:** `VerificationFailed` (R3 only); verifier PASS alone cannot complete.
13. **Merge conflict / incomplete delivery:** bounded continuation when actionable.
14. **No viable Attempt and runnable Task:** propose `CreateAttempt` (capacity claimed separately).
15. **Otherwise:** wait, including PR green but not yet merged; a persisted merge-wait deadline raises `waiting_for_merge_too_long` attention when exceeded.

Completion always outranks CI repair, dirty workspace and stale red checks. Changes-requested reviews are routed to attention in R1, not automatically dismissed.

## Runtime facts

A finished OpenCode turn is a factual runtime event.

Do not infer turn completion only from `idle`.

The runtime adapter provides:

```text
turn/submission identity
submitted
running
completed
failed
execution busy/idle
environment health
```

When a worker turn completes:

1. record runtime fact;
2. refresh workspace Git facts;
3. only then decide whether another continuation is required.

## Action outbox

### ActionRecord

```rust
struct ActionRecord {
    id: ActionId,
    schema_version: u32,

    task_id: TaskId,
    attempt_id: Option<AttemptId>,

    generation: u64,

    kind: ActionKind,
    class: ActionClass,

    cause_fingerprint: String,
    idempotency_key: String,

    payload: Value,

    state: ActionState,

    created_at: Timestamp,
    started_at: Option<Timestamp>,
    completed_at: Option<Timestamp>,

    error: Option<Failure>,
}
```

### States

```rust
enum ActionState {
    Pending,
    Executing,
    Succeeded,
    Failed,
    UnknownOutcome,
    Superseded,
}
```

`UnknownOutcome` means Anvil cannot safely determine whether a side effect occurred before a process/network failure.

Such actions are recovered by observation according to the action kind's declared recovery rule.

### Classes

```rust
enum ActionClass {
    Idempotent,
    Observable,
    Irreversible,
}
```

R1 contains no irreversible merge Action.

## Idempotency keys and unknown outcomes

Derive the stable key from `(task_id, attempt_id?, action_kind, cause_fingerprint)`, except `CreateAttempt` which is keyed from **`(task_id, role, ordinal)`**. Never use mutable Task version in that key.

For `ChecksFailed`, cause includes head SHA, failing required check identities and normalized failure fingerprint. For `FinishDelivery`, cause includes completed run identity, observed head and worktree fact hash. `SendTurn` records the requested message/turn identity when supported.

Outbox rows are unique by key, insert-or-ignore. After a restart an uncertain SendTurn is **not blindly resent**. First query the actual OpenCode session/message/run; classify observed accepted/executing/completed, safely-not-applied, or `UnknownOutcome`. Ambiguity yields explicit attention unless adapter-proven safe resubmission exists. OpenCode `messageID` support must be validated against Anvil's pinned version, not assumed to provide exactly-once execution.

Every Action records `rule_id` and a declared recovery strategy; `GET /v1/tasks/{id}/decisions` explains why decisions were made.

## Action/state ownership

Executing an Action does not directly invent semantic Task/Attempt progress beyond ActionRecord bookkeeping.

External/runtime observations drive factual state.

For example, `StopRuntime` does not immediately mark an Attempt ended. Runtime observation later proves it ended.

`SendContinuation` does not directly mark a Task working. Runtime observation records the new turn as submitted/running.

## Execution adapters

Conceptually:

```rust
trait ExecutionAdapter {
    observe_runtime(...);
    create_runtime(...);
    send_turn(...);
    stop_runtime(...);
}
```

Production implementations:

```text
LocalExecutionAdapter
KubernetesExecutionAdapter
```

R1 must work fully with the local adapter.

Kubernetes is infrastructure acceptance, not a prerequisite for deterministic controller tests.

## Code-host adapter

Conceptually:

```rust
trait CodeHostAdapter {
    observe_delivery(...);
}
```

R1 production implementation:

```text
GitHubCodeHost
```

Do not build a generic plugin framework for this.

## Separate observer scheduler and GitHub authority

**Observation collection is NOT the pure reconciler.** A separate observer scheduler persists next-poll due time, latest collection sequence, last success/failure, provider error class, backoff, and head-related refresh triggers. It polls Task-linked repo/branch/PR and obtains facts through CodeHostAdapter; changed facts wake reconciliation. A provider error does not erase healthy prior facts or become a coding failure; stale facts cannot complete.

On startup and periodically, poll exact known Task resources rather than global PR scans. When PR binding is absent, discover by repository + deterministic work branch and independently persist the result.

**CI check semantics:** for the exact observed head SHA, collect GitHub Checks API runs **and commit statuses** relevant to the applicable branch-protection/ruleset-required contexts. Normalize each required context to `Pending | Passing | Failing | Unknown`; optional checks do not automatically cause a ChecksFailed continuation. Missing/unreported required checks are Pending/Unknown, never Passing. If required context policy is inaccessible or ambiguous, mark unknown and avoid claiming green. Check summaries/logs require repo-scoped least-privilege credentials, bounded excerpts, redaction and explicit untrusted-input labeling.

Observations of `delivery.checks` include **head SHA** plus requiredness, check names, provider identifiers, states, collection sequence and freshness/expiry. A head change invalidates prior checks and verification. Provider event timestamps are metadata; Anvil-assigned collection sequence establishes ordering.

A green, review-ready PR that never merges remains waiting until the configured merge-wait deadline; then surface `waiting_for_merge_too_long` attention.

## Who merges?

R1 policy:

> Anvil does not execute merge.

Merge may be performed by repository automation, Mergify, GitHub auto-merge, a human/operator, or a future explicit integration action.

Anvil observes the result.

Therefore R1 has no irreversible GitHub merge Action.

For PullRequest delivery, successful delivery is:

```text
GitHub reports PR merged
```

Queue membership, auto-merge enabled, approval, mergeability, and green checks are not terminal completion facts.

## Head fencing

All CI/verification evidence is bound to a concrete delivery head SHA.

If head changes:

- prior check evidence cannot satisfy the new head;
- prior verification evidence cannot satisfy the new head;
- reconciliation waits for fresh evidence.

A later revert after merge is new work. Historical Task completion remains immutable.

## LocalBranch delivery

Retain the offline `LocalBranch` completion kind, but do **not** invent a generic `just check` contract for arbitrary Nix projects. In R1 its minimal evidence producer is Anvil's trusted Workspace/Git observer: verify the deterministic branch and a durable committed checkpoint at an exact SHA, with no uncommitted state required by the policy. Emit trusted `delivery_complete` for that checkpoint. If the Task separately requires `deterministic_verification`, it cannot complete until a real evidence-producing verifier exists; do not fabricate that fact.

The main recursive factory E2E exercises the PullRequest flow through fake GitHub and does not require LocalBranch to impersonate GitHub.

## Continuation reasons

```rust
enum ContinuationReason {
    MergeConflict,
    ChecksFailed,
    VerificationFailed,
    DeliveryMissing,
    FinishDelivery,
    BlockerResolved,
}
```

Each maps to one stable prompt template.

No supervisor LLM composes continuation prompts.

### Untrusted evidence in prompts

CI logs, review comments, external issue text, and provider errors are untrusted data.

Before inclusion:

- label provenance;
- sanitize control characters;
- truncate to configured bounds;
- redact detected credential/secret material;
- use artifact references for large logs.

Prompt delimiters must make clear that evidence is data, not instruction.

External evidence cannot alter task scope, tool permissions, credentials, integration authority, or controller policy.

## CI repair loop

R1 supports:

```text
worker turn completed
→ PR exists
→ current-head checks failed
→ ChecksFailed Action
→ same healthy Attempt/session receives continuation
```

After the continuation completes, refresh Git and GitHub before deciding again.

### Duplicate failure suppression

Do not repeatedly send the same continuation for unchanged failure evidence.

`cause_fingerprint` includes:

```text
head SHA
failing check identities
normalized failure result
```

If unchanged and a continuation was already delivered, do not issue another identical turn merely because polling repeats the state.

A rerun without worker changes is appropriate only when explicit policy classifies the failure as transient/infrastructure.

## Budgets, no-progress, and deferred capacity

The Task's immutable budget is an initial allocation plus audited `BudgetGrant` entries. R1 enforces attempts, per-reason continuations, CI reruns and **active execution seconds**; time on hold, blocked, provider-down, or awaiting CI/merge is not execution time. Exhaustion leaves the Task Open with `needs_budget` attention. Explicit operator give-up may transition to `FailedExhausted`.

Stable CI failure on unchanged head/worktree after a completed continuation is `no_progress` attention rather than repeatedly prompting or silently waiting. Repeat the same check without code changes only when deterministic policy classified the failure as transient.

A per-Task pure reconciler cannot enforce controller-wide capacity. `CreateAttempt` is a proposal; the **existing transactional global-capacity admission/claim** performs the actual allocation. `Deferred(capacity)` is a non-failure with future wakeup, not an Attempt nor a budget debit.

Retry backoff is durable and surfaced in the TaskSnapshot. Preserve explicit exponential retry policy (10s base, 300s cap), with logical-time evaluation.

## Completion evaluation

Reuse immutable Task completion policy.

Conceptually:

```rust
fn evaluate_completion(
    task: &Task,
    trusted_evidence: &[TrustedEvidence],
    child_states: &[TaskLifecycle],
    now: LogicalTime,
) -> CompletionEvaluation
```

Pure.

Agent observations cannot be passed as trusted evidence.

Typical Pull Request Task:

```text
CompletionPolicy::Evidence {
    required = [delivery_complete]
}
```

where `delivery_complete` means provider-observed merged PR for the bound delivery.

Aggregate default:

```text
AllChildrenCompleted
```

## Operator hold

Every Task has mutable `operator_hold`.

While held:

- observation continues;
- no new implementation/retry/continuation actions execute;
- no replacement Attempt is created.

Manual operator commands against Task-owned runtime that would fight automation should set operator hold first or require an explicit force path.

Resuming automation explicitly clears the hold.

## Blockers

With an unresolved blocker:

```text
no continuation
no fresh Attempt
```

Observation refresh may continue.

After resolution:

- reuse the healthy existing Attempt/session via `BlockerResolved`;
- otherwise create a replacement Attempt subject to budget.

## Startup recovery and controlled migration of authority

1. Open/migrate durable store and inspect `ControllerMode`.
2. Reconcile ambiguous in-flight outbox Actions **by observation**; do not immediately resend SendTurn or claim an Attempt vanished due to an unreachable provider.
3. End definitively orphaned Attempts through factual runtime absence, preserving continuity if runtime still exists.
4. Recover snapshot/action-intent generation and observer next-poll deadlines.
5. In Shadow mode, record decisions but never dispatch Actions. Compare against legacy execution traces before takeover.
6. Transfer ownership `Legacy → Reconciler` transactionally/CAS for an explicit cohort, adopting healthy existing Attempts and fencing legacy scheduler dispatch/completion.
7. Reconcile all nonterminal Tasks; only then admit new queued work.

No automatic fallback from Reconciler to Legacy. An ambiguous pending side effect is `UnknownOutcome`/attention until outcome can be established.

## Garbage collection

A runtime is GC-eligible only when:

```text
Task is terminal
AND no unresolved Action requires runtime
AND no active Attempt remains
AND required durable evidence/bindings are persisted
AND operator_hold is false
AND no preservation/grace-period requirement applies
```

R1 may delete Session, local/Kubernetes Sandbox, and disposable workspace.

Retain:

- Task;
- Attempts;
- reconcile decisions/snapshots;
- Actions;
- observations;
- failures;
- completion evidence.

On startup classify every Anvil-owned runtime as:

```text
owned by active Task
terminal cleanup candidate
orphan
```

Non-success terminals such as explicit `FailedExhausted` receive an operator-inspection GC grace period. Operator-held Tasks are not destructively GC'd. Preserve dirty/uncommitted work; use non-destructive local checkpoint refs/snapshots as an opt-in preservation mechanism, not automatic commits/pushes on every turn. No indefinite runtime graveyard.

## Attention API

Expose:

```text
GET /v1/tasks?attention=true
```

R1 attention reasons include:

```text
operator_hold
unresolved blocker
budget exhausted
terminal predecessor blocks dependency
unknown Action outcome
no_progress
needs_budget
waiting_for_merge_too_long
closed_unmerged / changed_requested_review / branch_deleted
orchestrator invariant failure
ambiguous delivery/provider state
```

Normal running/waiting/retry-scheduled Tasks do not require attention.

Return structured reason codes.

## R2: GitHub webhooks

When added:

```text
GitHub webhook
→ verify signature
→ dedupe delivery ID
→ persist event
→ identify affected Task(s)
→ wake reconciliation
```

Webhook payloads never directly transition Tasks.

After wakeup, poll current authoritative GitHub state.

Startup/periodic polling remains correctness repair.

Duplicate, delayed, out-of-order, and missing webhooks must converge to the same result once authoritative provider facts agree.

## R3: verification

Run Task-owned holdout scenarios outside implementation-worker knowledge.

Holdout results generated by Anvil-controlled execution may become trusted deterministic evidence.

Create `AttemptRole::Verification` with a fresh worker/session.

It receives Task outcome, acceptance criteria, current exact head SHA, repository/diff, and deterministic evidence, but not implementation-worker private planning transcripts.

Verifier output:

```json
{
  "verdict": "pass | fix | needs_human",
  "findings": []
}
```

Verifier output has Agent provenance.

Therefore:

```text
fix         → may block/return findings
needs_human → attention
pass        → removes verifier veto
```

but PASS alone can never complete a Task.

New delivery head invalidates verifier result.

## R4: Lific WorkSource

Lific is a work queue adapter, not Anvil's execution-state database.

Configured selectors identify eligible issues.

Example:

```text
project in configured projects
status = todo
label = anvil:auto
```

`(provider=lific, external_id=issue-id)` maps idempotently to one active Task.

Store external ref, source content hash, and immutable imported Task spec.

Changed hash creates `source_changed`; it does not rewrite the Task.

Deleted source creates `source_missing`; it does not cancel the Task.

Minimal outward reflection:

```text
Task starts      → issue active
needs_input      → blocker comment/state
Task completed   → issue done
Task canceled    → issue canceled
```

External Done after import does not silently terminate Anvil work.

## R5: infrastructure incidents

Failures may later correlate into Incident records.

Initial default correlation requires at least two unrelated Tasks within a configurable window sharing a high-confidence platform/sandbox fingerprint, unless a deterministic platform probe independently confirms a broad incident.

Incident includes domain, fingerprint, timestamps/reprobe deadline, affected Tasks, and status.

Require:

- TTL/re-probe;
- manual detach;
- stale incidents cannot hold work forever.

No LLM incident investigator in this milestone.

## Self-hosted deterministic development

This is release-blocking:

> Anvil must be able to develop Anvil.

The authoritative local factory test must not require GitHub, Lific, Kubernetes, an external model API, or Docker-in-Docker.

Loopback networking is allowed.

### Test layers

#### Core

Pure:

```text
TaskSnapshot
+ LogicalTime
→ Actions
```

No network/process/filesystem.

#### Adapter contracts

Local HTTP fixtures for GitHub and future Lific/OpenCode protocol boundaries.

#### Factory E2E

Real:

```text
anvild
OpenCode
LocalExecutionAdapter
local Git repos
anvil-test-model
anvil-test-world
```

#### Kubernetes acceptance

Separate infrastructure lane only.

## anvil-test-world

Add a deterministic fixture service analogous to `anvil-test-model`.

It emulates only external state Anvil consumes.

R1:

```text
GitHub repository/PR identity
PR head
checks
merge state
temporary provider failures
```

R2 adds webhook controls.

R4 adds Lific surfaces.

Tests advance the external world explicitly instead of waiting for real services.

## Recursive self-hosting acceptance

From an outer Anvil sandbox developing `blogle/anvil`:

```text
nix develop -c just e2e
```

must start inner local Anvil and drive a fixture Task through a real autonomous lifecycle.

R1 representative scenario:

```text
Task accepted
→ implementation Attempt starts
→ deterministic test model edits repo
→ delivery branch/checkpoint produced
→ fake GitHub PR associated
→ fake GitHub reports CI failure
→ reconciler produces ChecksFailed continuation
→ same Attempt repairs
→ fake GitHub reports healthy current head
→ fake GitHub reports merge
→ completion policy evaluates true
→ Task terminal Completed with evidence
→ runtime GC
```

Then exercise process crashes at persistence boundaries.

## Named compile-gated failpoints and crash injection

Implement a **test-only, compile-gated named failpoint mechanism**, inert/unavailable in production builds. Name at least these eight boundaries:

1. `reconcile.before_decision_commit` — before atomic decision+action transaction commit (rollback must be total).
2. `reconcile.after_decision_commit`.
3. `outbox.before_claim`.
4. `outbox.after_claim_before_dispatch`.
5. `outbox.after_side_effect_before_result_commit`.
6. `observer.after_observation_commit_before_wake`.
7. `task.before_terminal_commit`.
8. `gc.after_schedule_before_cleanup`.

Crash/restart from each boundary against the same durable SQLite store. Assert no duplicate cause-based continuation or Attempt allocation, no lost Task or falsely inferred runtime absence, and an explicitly recorded unknown outcome when neither replay nor observation can prove an external effect.

## Convergence/property testing

Cover:

### Deterministic replay

Same snapshot + time produces identical Actions.

### Duplicate observation tolerance

Repeating an observation changes nothing.

### Out-of-order facts

Older facts cannot overwrite newer facts.

### Wake multiplicity

Duplicate wakes produce the same committed generation/action set as one wake.

### Delivery convergence

For equivalent final authoritative provider facts, sequences containing duplicated, dropped, or reordered wake events produce the same terminal Task state after periodic repair.

The invariant is not deterministic external history; it is deterministic decision-making and eventual convergence once authoritative facts agree.

## R1 definition of done

**Pre-production gates:** verify pinned OpenCode SendTurn/message identity and ambiguous-response behavior; prove Legacy/Shadow decisions replay correctly and cut over an existing Attempt without duplicate execution. Do not dispatch production autonomous work before these pass.


1. `reconcile(snapshot, logical_time)` is pure and deterministic.
2. Every decision persists serialized/versioned/hashable snapshot and Actions.
3. Stored decisions pass replay validation.
4. Per-Task reconciliation is single-flight.
5. Every Action is fenced by reconcile generation.
6. Action idempotency uses cause-based derivation.
7. Durable outbox supports `UnknownOutcome`.
8. Actions do not directly invent semantic Task state.
9. GitHub polling discovers current PR/head/check/merge facts independently.
10. Current-head CI failure produces one bounded continuation to the same Attempt.
11. Unchanged failure does not create duplicate continuations.
12. Head changes invalidate prior delivery evidence.
13. Anvil performs no merge in R1.
14. Provider-observed PR merge can produce trusted `delivery_complete` evidence.
15. LocalBranch delivery uses the same completion machinery offline.
16. Immutable completion policy is the only route to Completed.
17. Agent-provenance evidence cannot satisfy completion.
18. Task budgets bound Attempts/continuations/time.
19. `operator_hold` prevents autonomous restart/continuation.
20. Blocker resolution reuses a healthy existing Attempt where possible.
21. Startup recovers Attempts, Actions, and Tasks without transcript inspection.
22. Terminal Tasks safely GC runtime.
23. `GET /v1/tasks?attention=true` exposes genuine exceptions.
24. Recursive local factory E2E runs inside an Anvil sandbox with no external services.
25. Crash injection covers major outbox boundaries.
26. `nix develop -c just check` passes.
27. `nix develop -c just e2e` passes.
28. Snapshot/action-history and budget counters prevent repeat action on unchanged failure and expose no_progress.
29. No-op periodic sweeps do not continuously persist decisions, bump action generation or cancel in-flight Actions.
30. GitHub observations distinguish required/optional checks and statuses; provider failure cannot turn stale facts into success.
31. Shadow cutover and pinned OpenCode ambiguous-turn recovery gates have executable evidence.
32. Eight named failpoints and decision-rule trace API are tested.

## Explicit R1 non-goals

Do not include in first-wave implementation:

- GitHub webhooks;
- Lific queue polling;
- verifier execution;
- holdout execution beyond Task-model readiness;
- incident correlation;
- automatic planning/decomposition;
- generic workflow DSL;
- model routing;
- mob coordination;
- Anvil-executed merge;
- multi-repository writable sandboxes;
- ChatGPT callbacks/backlinks.