# Deterministic Orchestration and Reconciliation

## Status

Canonical specification for Anvil's deterministic task-convergence controller. This supersedes older batch-supervision designs where they conflict.

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

## Milestones

This specification describes the full reconciler architecture, but implementation must land incrementally.

### R1 — first-wave MVP

Implement:

- versioned/hashable TaskSnapshot input;
- pure reconciler;
- serializable logical time;
- deterministic continuation priority;
- per-Task single-flight;
- reconcile-generation fencing;
- durable Action outbox;
- GitHub polling adapter;
- CI-failure → continuation loop;
- Pull Request merged terminal predicate;
- LocalBranch terminal predicate for offline tests;
- completion-policy evaluation;
- Task garbage collection;
- `attention=true`;
- recursive local E2E;
- restart/crash tests.

Stop after R1 works.

### R2 — event latency

Add GitHub webhooks, durable webhook inbox/deduplication, and event-driven wakeups. Periodic polling remains correctness authority.

### R3 — verification

Add deterministic holdout execution, Verification Attempts, head-SHA-bound verifier/fixer loops, and bounded verifier cycles.

### R4 — external work queues

Add Lific WorkSource ingestion, source hashing/drift detection, and blocker/status reflection.

### R5 — infrastructure incidents

Add richer failure classification, cross-task correlation, Incident objects, incident TTL/re-probe, and manual detach.

Do not combine all milestones into one implementation ticket.

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

## Durable reconcile artifact

Reuse the Task Primitive's canonical `TaskSnapshot`.

For every committed reconciliation persist:

```rust
struct ReconcileDecision {
    schema_version: u32,

    task_id: TaskId,
    task_version: u64,

    generation: u64,

    logical_time: LogicalTime,

    snapshot_json: Value,
    snapshot_hash: Hash,

    actions_json: Value,
    actions_hash: Hash,

    created_at: Timestamp,
}
```

The snapshot is built in one DB read transaction and is the exact input used to decide the persisted Actions.

### Replay invariant

For every stored decision:

```text
reconcile(stored_snapshot, stored_logical_time)
==
stored_actions
```

Test this in unit tests and checked-in replay fixtures.

A production orchestration defect should be reducible to a stored snapshot/action trace and replayed offline.

## Logical time

Do not use `Instant` inside reconciliation logic.

Use a serializable newtype:

```rust
struct LogicalTime(i64);
```

Wall-clock acquisition occurs outside the pure reconciler.

Retry deadlines, stale observations, and wall-clock budgets are evaluated relative to the supplied logical time.

## Per-Task concurrency and fencing

### Single flight

Only one reconciliation pass for a Task may actively construct/commit a decision at a time within one `anvild`.

Use a per-Task keyed lock.

This is not the only correctness mechanism.

### Reconcile generation

Every committed reconciliation increments:

```text
task.reconcile_generation
```

Every Action carries that generation.

Immediately before execution:

```text
action.generation == task.current_generation
```

must still be true.

Otherwise the Action becomes `superseded` and performs no side effect.

This fences webhook, periodic, runtime, blocker, and startup wakes racing one another.

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

## Reconcile decision priority

Implement one exhaustive decision/match function rather than scattered overlapping rules.

Initial total order:

```text
1. Task terminal
2. operator_hold
3. unresolved blocker
4. active platform/runtime recovery condition
5. active Attempt currently executing a turn
6. merge conflict requiring worker action
7. CI/check failure requiring worker action
8. verification rejection requiring worker action
9. missing/incomplete delivery requiring worker action
10. completed worker turn + unfinished workspace/delivery
11. resolved blocker requiring continuation
12. no viable active Attempt + runnable Task
13. completion policy now satisfied
14. waiting
```

Table-driven and property tests must cover simultaneous/conflicting facts.

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

## Idempotency derivation

Pin Action idempotency to:

```text
(task_id, attempt_id?, action_kind, cause_fingerprint)
```

canonicalized and hashed.

Examples:

```text
ChecksFailed + headSHA + check-suite-state-hash
FinishDelivery + turnID + workspace-head + dirty-state-hash
CreateAttempt + taskVersion + ordinal
```

The same cause must not generate duplicate continuations after restart/reconciliation.

A changed cause may produce a new Action.

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

## GitHub polling is authoritative in R1

For every active PullRequest-delivery Task, poll exact known resources.

Observe:

```text
work branch/head
associated Pull Request
Pull Request head SHA
Pull Request open/closed/merged
checks/check suites
review state where useful
mergeability where useful
```

Do not globally scan every open PR.

Before a durable PR binding exists, discover it by exact repository + Task work branch/head.

Once found, persist the binding.

Poll:

- on startup;
- after relevant worker turns;
- periodically while active;
- after adapter-error retry deadlines.

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

Offline/self-hosted execution must not require GitHub.

For `DeliveryKind::LocalBranch`, trusted `delivery_complete` evidence may be produced when:

- the deterministic Task branch exists;
- the expected durable Git checkpoint exists;
- required deterministic local verification evidence is present according to the Task completion policy.

This lets inner Anvil exercise actual completion semantics entirely on localhost.

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

## Budgets

Enforce at minimum in R1:

- `max_attempts`;
- `max_continuations_per_reason`;
- `max_ci_retries`;
- `max_wall_clock_seconds`.

When exhausted, surface attention rather than continuing silently.

Infrastructure retry delay:

```text
delay = min(10s * 2^(n-1), 300s)
```

evaluated against logical time.

Cost/token enforcement may follow when telemetry is trustworthy; the Task schema already reserves it.

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

## Startup recovery

On `anvild` startup:

1. open/migrate durable store;
2. recover unfinished Actions;
3. reconcile `Executing` Actions into succeeded, retryable pending, or `UnknownOutcome` based on observation;
4. recover orphaned Attempts from factual runtime observations;
5. build fresh snapshots for every nonterminal Task;
6. reconcile every nonterminal Task;
7. only then admit new queued work.

Do not recover semantic Task state by reading model transcripts.

## Garbage collection

A runtime is GC-eligible only when:

```text
Task is terminal
AND no unresolved Action requires runtime
AND no active Attempt remains
AND required durable evidence/bindings are persisted
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

No indefinite runtime graveyard.

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

## Crash injection

R1 E2E kills/restarts Anvil at least:

```text
after snapshot persisted, before Actions persisted
after decision/action transaction committed
before Action execution
while Action is executing
after side effect, before Action success persisted
after observation persisted, before next reconcile
during terminal transition
during GC scheduling
```

After restart:

- no duplicate irreversible behavior;
- no duplicate worker continuation for same cause;
- Task converges or surfaces explicit unknown/attention state;
- DB invariants hold.

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
