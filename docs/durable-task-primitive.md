# Durable Task Primitive

## Status

Canonical specification for the first-wave durable Task foundation. Revised 2026-10-08 to resolve snapshot/action-history completeness, controller ownership and cutover, retry/capacity contracts, and observation ordering. This supersedes the older batch-centric orchestration design where it conflicts.

## Objective

Promote Anvil's existing Task/Attempt scheduler into the canonical durable representation of autonomous work.

A **Task** is the durable requested outcome.

An **Attempt** is one bounded execution effort to advance a Task.

A **Session/Sandbox/OpenCode conversation** is runtime machinery owned by an Attempt.

The resulting model must survive process restarts, runtime loss, external-provider outages, eventual sandbox garbage collection, and later expansion into task graphs, queue adapters, verification and deterministic reconciliation without another foundational data-model migration.

This lane establishes durable semantics and APIs. It does **not** implement the full autonomous convergence loop.

## Architectural invariants

1. **Task is authoritative.** Task identity and history survive all execution resources. Destroying or replacing a Session or Sandbox must not destroy the Task or erase Attempt history.

2. **Batch is not ownership.** Batch remains a submission/grouping/concurrency primitive. A Task may exist without a Batch. Existing batch APIs must route through the same canonical Task creation path.

3. **Task represents an outcome, not necessarily a repository.** A Task may be an executable leaf targeting one Git repository or an aggregate/root Task with no execution target. In v1, each executable leaf has at most one writable Git repository. Cross-repository outcomes use parent/child Tasks and dependencies.

4. **Immutable task specification.** Once accepted, outcome, acceptance criteria, completion policy, verification specification, execution target, and execution budget are immutable. Changes create a new Task and may supersede the old one.

5. **Completion is explicit.** Every Task has an immutable `CompletionPolicy`. Idle workers, clean exits, clean workspaces, green CI, child completion, or verifier approval do not implicitly complete a Task.

6. **Agent claims cannot complete Tasks.** Every Observation has provenance. Agent-provenance observations may report blockers or diagnostics but can never become trusted completion evidence.

7. **Concurrency invariants live in the database.** Task, Attempt, and Blocker transitions are versioned/CAS; the DB enforces one live Attempt per `(task_id, role)`, unique Attempt ordinal per Task, and one unresolved blocker per Task.

8. **Durable state does not require OpenCode inspection.** After restart, Task ownership, lifecycle, dependencies, Attempt history, blockers, completion evidence, and delivery bindings are reconstructible without querying or replaying an OpenCode transcript.

9. **External systems are references, not Task-state authorities.** Lific, GitHub issues, observability incidents, ChatGPT requests, and future work sources provide ingestion/deduplication/traceability but do not replace Anvil's durable execution state.

## Domain model

### Task

Conceptually:

```rust
struct Task {
    id: TaskId,
    version: u64,

    outcome: String,
    acceptance_criteria: Vec<String>,

    parent_task_id: Option<TaskId>,
    execution_target: Option<ExecutionTarget>,

    completion_policy: CompletionPolicy,
    verification_spec: VerificationSpec,
    budget: TaskBudget,

    operator_hold: bool,
    controller_mode: ControllerMode, // Legacy | Shadow | Reconciler
    reconcile_generation: u64,

    lifecycle: TaskLifecycle,

    created_at: Timestamp,
    updated_at: Timestamp,
}
```

`version` increments on every mutable transition and is used for compare-and-swap writes.

`operator_hold` is mutable and is not part of the immutable requested outcome. While held, future reconciliation may observe state but must not create new Attempts or autonomous continuation turns.

### Execution target

v1:

```rust
enum ExecutionTarget {
    GitRepository {
        project: String,
        repository: Repository,
        base_ref: GitRef,
        delivery: DeliveryKind,
    },
}
```

Store this initially as typed JSON with a kind discriminator rather than normalizing speculative future execution-target fields.

No execution target means the Task is aggregate/non-runnable.

### Delivery kind and durable delivery binding

```rust
enum DeliveryKind {
    PullRequest,
    LocalBranch,
}
```

Every executable Git Task receives a deterministic work branch when created:

```text
anvil/<task-id>
```

Branch identity is Task intent, not an observation.

For Pull Request delivery:

```rust
struct PullRequestBinding {
    provider: String,
    repository: String,
    number: u64,
}
```

The PR binding begins absent and is durably attached once independently discovered.

`LocalBranch` provides a real offline/self-hosted delivery mode without pretending GitHub exists.

### Baseline revisions

The Task retains the immutable requested `base_ref`.

Before first execution, Anvil resolves and durably records an exact `base_revision`.

Each Attempt records an exact `start_revision`.

Later Attempts may therefore resume durable work from prior Attempts while retaining the original Task baseline.

## Completion policy

```rust
enum CompletionPolicy {
    Evidence {
        required_kinds: Vec<EvidenceKind>,
    },
    AllChildrenCompleted,
    Manual,
}
```

v1 deliberately avoids a general expression/predicate DSL.

### Evidence

All listed evidence kinds must be satisfied by fresh trusted evidence.

### AllChildrenCompleted

Every direct child must be terminal `Completed`.

This is the default for aggregate/root Tasks unless explicitly overridden. If semantic end-to-end validation is required, ChatGPT should include an explicit integration/verification child.

### Manual

Requires an explicit trusted operator completion action.

### Initial EvidenceKind vocabulary

Keep the first vocabulary small:

```text
legacy_scheduler_exit
delivery_complete
deterministic_verification
manual_completion
```

### Trusted completion evidence

A completed terminal stores the exact evidence used:

```rust
struct CompletionEvidenceRef {
    observation_id: ObservationId,
    observation_version: u64,
    evidence_kind: EvidenceKind,
}
```

```rust
TaskTerminal::Completed {
    evidence: Vec<CompletionEvidenceRef>,
}
```

The completion evaluator accepts only trusted evidence. Conversion from an Agent-provenance observation to trusted evidence must be structurally impossible or rejected by type/API.

## Typed terminal results

```rust
enum TaskTerminal {
    Completed {
        evidence: Vec<CompletionEvidenceRef>,
    },
    Canceled {
        actor: ActorRef,
        reason: String,
    },
    Obviated {
        reason: String,
    },
    Superseded {
        by_task_id: TaskId,
    },
    FailedExhausted {
        attempt_budget: u32,
        last_failure: Option<FailureRef>,
    },
}
```

Historical terminal state is immutable. A later revert or external change creates new work rather than reopening historical completion.

## Task budget and audited grants

Each Task has an immutable **initial** execution allocation and an append-only grant ledger. Exhaustion does **not** automatically terminalize a Task; it becomes Open with attention reason `needs_budget`. Explicit operator `give_up` may terminalize it as `FailedExhausted`; an operator may instead authorize a `BudgetGrant`. Accepted Tasks are never silently superseded to raise limits.

```rust
struct TaskBudget {
    max_attempts: u32,
    max_continuations_per_reason: u32,
    max_verifier_cycles: u32,
    max_ci_retries: u32,
    max_execution_seconds: u64,
    max_model_cost: Option<Money>,
}
struct BudgetGrant {
    task_id: TaskId,
    actor: ActorRef,
    reason: String,
    additional_attempts: u32,
    additional_continuations: u32,
    additional_ci_retries: u32,
    additional_execution_seconds: u64,
    recorded_at: Timestamp,
}
```

Time budget counts **active agent runtime/turn time**, not operator hold, waiting for CI/merge, an unresolved blocker, or external-provider downtime. Use a separate merge-wait deadline for `waiting_for_merge_too_long` attention. BudgetUsage aggregates from durable Attempts, Actions, execution-time intervals, and grants; never rely on model prose or an in-memory counter. R1 enforces attempts, continuations, CI retries and execution-time budgets. Cost enforcement is optional until trustworthy telemetry exists.

`POST /v1/tasks/{id}/budget-grants` is an authenticated, audited operator-only mutation using Task CAS. `FailedExhausted` is an explicit terminal give-up, not a side effect of reaching a configured budget.

## Verification specification

Reserve verification policy now even though verifier execution is deferred:

```rust
struct VerificationSpec {
    holdout_scenarios: Vec<HoldoutScenario>,
}
```

Holdout scenarios belong to Anvil Task state and are not exposed to the implementation worker unless a future scenario explicitly requires it.

A future LLM verifier verdict is Agent provenance: it may block work, but cannot alone complete the Task.

## Attempt

```rust
struct Attempt {
    id: AttemptId,
    version: u64,

    task_id: TaskId,
    ordinal: u32,
    role: AttemptRole,

    session_id: Option<SessionId>,
    start_revision: Option<CommitSha>,

    lifecycle: AttemptLifecycle,
    exit_reason: Option<AttemptExitReason>,
    failure: Option<Failure>,

    started_at: Option<Timestamp>,
    ended_at: Option<Timestamp>,
}
```

Roles:

```rust
enum AttemptRole {
    Implementation,
    Verification,
}
```

Lifecycle remains factual:

```rust
enum AttemptLifecycle {
    Queued,
    Provisioning,
    Running,
    Ended,
}
```

Examples of exit reasons:

```text
completed_turn
runtime_lost
orphaned
canceled
abandoned
failed
replaced
```

Retry delay is controller/scheduler state, not an Attempt lifecycle.

### Attempt uniqueness

DB constraints:

```text
UNIQUE(task_id, ordinal)

UNIQUE(task_id, role)
WHERE lifecycle != 'ended'
```

Two concurrent scheduler/reconcile ticks must not create two live implementation Attempts.

### Startup orphan recovery

On startup:

1. inspect every non-ended Attempt;
2. consult durable runtime facts / ExecutionAdapter;
3. if the runtime/session definitively no longer exists, end the Attempt with `exit_reason=orphaned`;
4. never inspect OpenCode conversation content.

Temporary inability to reach a runtime is not proof it disappeared.

## Failure representation

For this lane, migrate existing failure vocabulary into:

```rust
struct Failure {
    domain: FailureDomain,
    code: String,
    summary: String,
    artifact_refs: Vec<ArtifactRef>,
}

enum FailureDomain {
    Work,
    Agent,
    Sandbox,
    Platform,
    Dependency,
    Orchestrator,
    Unknown,
}
```

`Unknown` is the default when no deterministic classifier applies.

Migration must contain explicit tested historical-state/failure mapping tables.

Large evidence is not stored as arbitrary DB blobs. Failure details are bounded, sanitized, secret-redacted, and represented by artifact references where large.

Sophisticated classification/correlation belongs to the reconciler lane.

## Observations

Use a minimal current-fact table:

```text
task_observations
  id
  task_id
  key
  value_json
  provenance
  observed_at
  recorded_at
  version
  collection_seq
  expires_at NULL
```

Current-value uniqueness:

```text
UNIQUE(task_id, key)
```

Namespaced keys include:

```text
runtime.execution
runtime.environment
git.head
git.workspace_dirty
delivery.pull_request
delivery.head
delivery.checks
delivery.merged
platform.nix_store
```

### Provenance

```rust
enum ObservationProvenance {
    Runtime,
    Platform,
    External,
    Agent,
}
```

Only non-Agent provenance may convert to `TrustedEvidence`.

### Ordering: collection sequence, not provider timestamps

`observed_at` represents Anvil collection time; provider event timestamps remain attributes inside `value_json`. Anvil's observer allocates a **durable monotonically increasing sequence for each task/key collection** before initiating a request. Store `collection_seq` on observations and reserve a new sequence for each poll.

For one `(task_id, key)`:
- newer `collection_seq` wins;
- older sequence cannot overwrite newer, even if it finishes later;
- same sequence plus identical canonical JSON is a duplicate;
- same sequence plus different JSON is a collection invariant error;
- `recorded_at` is when persistence succeeded, not a provider's timestamp.

Do not derive ordering from second-resolution timestamps or arrival order. A failed fetch must record collection failure/backoff separately, not overwrite a previously valid fact with an invented success.

### Equality/history

No schema registry in this lane.

Canonicalize JSON recursively. Append to existing durable history only when canonical value changes.

### Freshness

An Observation may have `expires_at`.

Expired facts remain historical but cannot satisfy freshness-sensitive completion. A stale passing-check observation cannot satisfy completion.

## Blockers

```rust
struct TaskBlocker {
    id: BlockerId,
    version: u64,

    task_id: TaskId,
    attempt_id: AttemptId,

    question: String,
    context: String,

    created_at: Timestamp,
    resolution: Option<BlockerResolution>,
}
```

Allow at most one unresolved blocker per Task via partial unique index.

### Creation API

```text
POST /v1/attempts/{id}/blockers
```

Requirements:

- authenticated using an Attempt/Session-scoped capability;
- Attempt must still be non-ended;
- caller may only create a blocker for its own Attempt;
- reject a second unresolved blocker for the Task.

Workers receive no equivalent `complete_task` capability.

### Resolution API

```text
POST /v1/tasks/{id}/blockers/{blocker_id}/resolve
```

Resolution records resolver, answer/resolution, and timestamp.

Resolution does not inherently create a fresh Attempt. If the existing Attempt/Session remains healthy, future reconciliation resumes the same Attempt; otherwise it creates a new Attempt subject to budget.

## Dependencies and hierarchy

### Parent hierarchy

`tasks.parent_task_id` describes decomposition/ownership.

The parent chain must be acyclic.

### Dependency graph

Normalize:

```text
task_dependencies
  predecessor_task_id
  successor_task_id
```

Only terminal `Completed` satisfies a dependency.

`Canceled`, `Obviated`, `Superseded`, and `FailedExhausted` leave successors Open but non-runnable.

No automatic dependency cascade.

### Graph validation

Inside the graph-insert transaction:

- reject self edges;
- reject parent cycles;
- reject dependency cycles;
- validate via recursive CTE;
- enforce configured maximum graph size.

Initial safety bounds:

```text
256 Tasks
2048 dependency edges
```

## Cancellation and obviation

### Default cancellation

`POST /v1/tasks/{id}/cancel`:

1. CAS the Task to terminal `Canceled` in one transaction;
2. record actor/reason;
3. commit terminal state;
4. best-effort runtime shutdown happens afterward;
5. active Attempt remains factual until runtime observation ends it.

The Task cannot be resurrected by delayed runtime observations.

Dependents and children are not automatically canceled.

### Explicit descendant cascade

Support:

```text
POST /v1/tasks/{id}/cancel?cascade=descendants
```

Cancel currently nonterminal descendants. Dependents outside that hierarchy are not canceled; they become blocked through ordinary dependency semantics.

### Obviation

Obviation uses the same in-flight Attempt semantics: terminal Task transition first, runtime stop best-effort afterward.

## External references

Use:

```text
task_external_refs
  id
  task_id
  provider
  external_id
  source_hash
  url NULL
```

For Open Tasks, `(provider, external_id)` must be unique.

A terminal Task retains its reference. Rediscovery must not automatically create a new Task.

If a terminal source reopens/changes, later importer logic surfaces new/superseding work instead of silently duplicating it.

Source deletion does not cancel a Task.

## Canonical TaskSnapshot: complete pure-decision input

Build a bounded, canonically ordered snapshot from **one database read transaction**. Never require runtime/client I/O during snapshot construction. The reconciler needs not only current observations but also the action history that prevents duplicate continuations, budget usage, retry deadlines, durable delivery identity, operator hold, controller ownership, and a fencing generation.

```rust
struct TaskSnapshot {
    schema_version: u32,
    task_id: TaskId,
    task_version: u64,
    logical_time: LogicalTime,  // supplied for evaluation, excluded from semantic hash

    lifecycle: TaskLifecycle,
    completion_policy: CompletionPolicy,
    operator_hold: bool,
    controller_mode: ControllerMode,
    reconcile_generation: u64,

    execution_target: Option<ExecutionTarget>,
    delivery: Option<DeliverySummary>, // branch + PR binding + head SHA
    dependency_summary: DependencySummary,
    child_summary: ChildSummary,
    active_attempts: Vec<ActiveAttemptSummary>,
    blocker: Option<BlockerSummary>,

    current_observations: Vec<Observation>,
    action_history: ActionHistorySummary,
    budget_usage: BudgetUsage,
    retry_schedule: RetrySchedule,
    phase: TaskPhase,
}
```

`ActionHistorySummary` includes at least action kind, attempt binding, cause fingerprint, idempotency key, state, outcome/turn identity, and when last dispatched for each still-relevant cause. It is bounded and may point to full cursor-paginated Action history.

`BudgetUsage` includes attempt count, continuations by reason, verifier cycles, CI reruns, active execution seconds, and applied grant totals. `RetrySchedule` includes due time and failure cause/class (and may include observer/merge-wait deadlines when relevant). All are derived from persisted records rather than in-memory counters.

The **semantic snapshot hash** is calculated from canonically ordered decision-relevant fields, excluding `logical_time`, volatile `recorded_at`, and other arrival-only metadata. Preserve deadline values themselves and evaluate due-time transitions using the separately persisted logical time. Canonical ordering is required for map/set/vector fields.

Initial coarse phase: `Terminal | Blocked | Running | Runnable | Waiting`. `derive_phase(snapshot, logical_time)` is pure and fixture-tested. Detailed attention reasons belong to the reconciler.

Children, Attempt history, Actions and decisions have separate cursor-paginated APIs; the decision snapshot carries only bounded decision-essential summaries.

## API

Required first-class API:

```text
POST /v1/tasks
GET  /v1/tasks
GET  /v1/tasks/{id}
GET  /v1/tasks/{id}/snapshot

POST /v1/tasks/graph

POST /v1/tasks/{id}/cancel
POST /v1/tasks/{id}/obviate
POST /v1/tasks/{id}/budget-grants
POST /v1/tasks/{id}/controller-mode

GET  /v1/tasks/{id}/attempts
GET  /v1/attempts/{id}

POST /v1/attempts/{id}/blockers
POST /v1/tasks/{id}/blockers/{blocker}/resolve
```

Task list filters include at minimum:

```text
lifecycle=open
runnable=true|false
parent=<task>
external_provider=<provider>
external_id=<id>
```

Use cursor pagination.

### Graph submission

Graph requests use client-local node keys. Anvil allocates durable TaskIds transactionally.

The idempotency identity is the canonical hash of the whole request body.

Same idempotency key + same canonical body replays the authoritative result.

Same key + different body returns HTTP 409.

Reuse existing Anvil idempotency machinery.

## Legacy scheduler bridge and controller cutover

Persist `ControllerMode = Legacy | Shadow | Reconciler` per Task, with explicit version/CAS transition. Existing Tasks begin in Legacy. New reconciliation-managed Tasks begin in Reconciler once R1 is enabled; the rollout may choose Shadow.

**Legacy:** existing scheduler is the sole execution authority and may call exactly one greppable `complete_task(task_id, TrustedEvidence::LegacySchedulerExit(...))` compatibility entrypoint.

**Shadow:** legacy remains sole execution authority. The new controller may observe real facts and persist replayable decisions, but its Actions are never dispatched. Shadow must not count as an extra Attempt or consume budgets.

**Reconciler:** transfer is transactional and fenced. Existing Attempt/session is adopted when viable; no duplicate attempt or lost continuity. The legacy scheduler must not dispatch or complete this Task after ownership transfers. Terminal state/legacy pending operations must be reconciled before takeover. Downgrading ownership requires an explicit operator migration, not an automatic fallback.

A controller-mode transition is an audited Task CAS write. Cutover must be tested with a running Attempt, a completed turn, and a pending legacy retry.

**Global capacity:** the pure reconciler only proposes `CreateAttempt`; existing transactional scheduler admission owns the global capacity claim. `Deferred(capacity)` is not a failure, Attempt, retry-budget debit, or reason to duplicate Actions.

## Migration

Use a forward-only migration.

Before production migration:

1. copy the controller DB;
2. retain the copy for recovery;
3. migrate transactionally;
4. run pre/post invariant checks.

Migration validation includes:

- Task row-count preservation;
- Task ID preservation;
- Attempt ID/ordinal preservation;
- Session binding preservation;
- idempotency-binding integrity;
- dependency-edge equivalence;
- batch membership preservation;
- historical Attempt state mapping;
- historical failure mapping.

Author state/failure mapping tables as tests before migration code.

Test every historical schema version still represented by migrations and a sanitized golden fixture copied from the real Anvil controller DB.

## Crash/concurrency tests

Crash injection covers persistence boundaries of:

```text
Task create
Task graph submit
Attempt creation/start
Task terminal transition
blocker creation/resolution
```

After each crash:

1. restart on the same SQLite DB;
2. assert invariants;
3. assert no duplicate live Attempt;
4. assert idempotent retry returns the authoritative resource.

Include concurrency tests proving the DB rejects two active Attempts for one `(Task, role)`.

Include a harness where constructing an OpenCode client panics and prove durable Task read/recovery still succeeds.

## Definition of done

1. Task is independently creatable without Batch.
2. Aggregate Tasks may have no execution target.
3. Executable Tasks have deterministic Task-owned branch identity.
4. Outcome, criteria, completion policy, verification spec, execution target, and budget are immutable.
5. Every Task has a concrete completion policy.
6. Completed terminal state stores exact trusted completion evidence.
7. Every non-success terminal stores a typed reason.
8. Agent-provenance observations cannot satisfy completion.
9. Task and Attempt transitions use version/CAS semantics.
10. DB constraints prohibit a second live Attempt per `(Task, role)`.
11. DB constraints prohibit more than one unresolved blocker per Task.
12. Dependencies are normalized and only Completed predecessors satisfy them.
13. Parent/dependency cycles are rejected transactionally.
14. Cancellation semantics for live Attempts and descendants are implemented and tested.
15. External refs are normalized and idempotent for active work.
16. Minimal observations obey deterministic ordering/freshness rules.
17. TaskSnapshot is built from one read transaction and phase derivation is pure.
18. Existing Batch APIs use canonical Task creation.
19. Legacy scheduler completion goes through one trusted compatibility function.
20. Historical migrations pass golden-fixture and crash-injection tests.
21. Task recovery works without constructing an OpenCode client.
22. `nix develop -c just check` passes.
23. Existing local E2E remains green.
24. Decision snapshots include action-history summary, budget usage, retry due, controller mode, operator hold, generation and durable delivery identity.
25. Collection-sequence ordering prevents an older in-flight poll from overwriting newer facts.
26. Shadow controller has no side effects; live cutover adopts existing Attempts and preserves transactional global-capacity admission.

## Explicit non-goals

This lane does not implement:

- autonomous convergence;
- GitHub polling/webhooks;
- Lific polling;
- independent verifier execution;
- incident correlation;
- automatic CI repair;
- sandbox GC policy;
- workflow DSL;
- automatic planning/decomposition;
- model routing;
- mob coordination;
- multi-repository writable workers;
- ChatGPT backlinks.