# Task ↔ Reconciler Integration Contract v0

**Status:** frozen first-wave integration boundary for ANVIL-55 and ANVIL-56, established after canonical specs PR #78 merged. This contract fixes names, shapes, ownership and semantics so the implementation lanes can proceed concurrently. If it conflicts with either canonical spec, the canonical safety invariants win; record the discrepancy in a PR rather than quietly improvising.

**No extra orchestration framework.** Retain existing batch scheduler, local E2E, idempotency and OpenCode runtime. This is a typed read-model and command boundary, not an instruction to replace all existing service code at once.

## 1. Workstream ownership and sequencing

| Area | ANVIL-55: durable Task foundation | ANVIL-56: reconciler R1 |
| --- | --- | --- |
| Shared DTOs | **Own** `crates/anvil-core/src/task.rs` and exports | **Consume** these types; never edit without coordinating |
| SQLite Task/Attempt/blocker/dependency schema and migration | **Own** `crates/anvild/src/store.rs`, `store/task*`, `store/scheduler.rs` | Read via Task repository interface; no direct alternate Task schema |
| Public Task HTTP API + legacy scheduler bridge | **Own** route wiring in `crates/anvild/src/lib.rs` until integration | R1c may wire observer/reconciler only after 55 merges |
| Pure controller + tests | No edits | **Own** new `crates/anvil-reconcile/` crate (or `reconciler/` module isolated from 55-owned files) |
| Outbox/decision store and observer scheduling | Provide Task lookup/CAS hooks | **Own** new `store/reconciler*` tables/modules; additive migration distinctly named and applied after Task migration |
| GitHub observation adapter and test world | No edits | **Own** new CodeHost adapter module and `crates/anvil-test-world/` |
| Existing global capacity admission | **Own** transaction/claim path and `Deferred(capacity)` semantics | Propose attempt actions; call/consume admission service during R1c |
| E2E and full service integration | Preserve existing E2E | Own R1c factory E2E **after** 55 API is merged |

ANVIL-56 may immediately implement **R1a/R1b** using the canonical JSON fixtures below, a minimal local deserialization mirror if necessary, and a mock `TaskStorePort`. It must not implement a competing production Task persistence layer. When ANVIL-55 publishes the `anvil-core` DTOs, 56 replaces temporary fixture DTOs with the shared types and adds serialization compatibility tests. This is a small integration step, **not a full-task serial dependency**.

ANVIL-55 must commit the shared DTO skeleton + golden JSON fixture early, before completing the migration, so 56 can wire actual shared types promptly. Any contract change requires a visible version change, both workers' agreement, and one reviewed PR; do not silently rename fields.

## 2. Shared data vocabulary (Serde snake_case)

Use stable IDs as opaque strings (`TaskId`, `AttemptId`, `ActionId`, `ObservationId`). Public payload IDs must not encode ownership semantics. Timestamps are UTC RFC3339 for external APIs; **internal logical time and due times** are `i64` Unix milliseconds. The snapshot's `logical_time_ms` is supplied by the controller and excluded from its semantic hash.

Required public enum names:

```text
TaskLifecycle: open | terminal
TaskTerminal: completed | canceled | obviated | superseded | failed_exhausted (typed reason/evidence payload)
AttemptRole: implementation | verification
AttemptLifecycle: queued | provisioning | running | ended
ControllerMode: legacy | shadow | reconciler
DeliveryKind: pull_request | local_branch
TaskPhase: terminal | blocked | running | runnable | waiting
ObservationProvenance: runtime | platform | external | agent
ActionState: pending | executing | succeeded | failed | unknown_outcome | superseded
ActionClass: idempotent | observable | irreversible
CheckState: pending | passing | failing | unknown
CheckEvaluationKind: head | test_merge | merge_group
```

`TaskPhase` is **derived**, not a durable third lifecycle. OpenCode busy/idle is factual runtime state, not Task completion. Never use agent-provenance evidence to complete.

## 3. Versioned TaskSnapshot DTO

ANVIL-55 owns the production serializer. ANVIL-56 owns the pure consumer. Minimal top-level JSON contract (additional nested fields permitted in v0 if documented; required fields must not disappear):

```json
{
  "schema_version": 1,
  "task_id": "task_demo",
  "task_version": 8,
  "logical_time_ms": 1791600000000,
  "reconcile_generation": 2,
  "controller_mode": "reconciler",
  "operator_hold": false,
  "lifecycle": {"state": "open"},
  "phase": "waiting",
  "completion_policy": {"kind": "evidence", "required_kinds": ["delivery_complete"]},
  "execution_target": {"kind": "git_repository", "repository": "https://example.test/repo", "base_ref": "main", "delivery": "pull_request"},
  "delivery": {
    "work_branch": "anvil/task_demo",
    "base_revision": "1111111111111111111111111111111111111111",
    "pull_request": {"provider": "github", "repository": "example/repo", "number": 42},
    "pr_head_sha": "2222222222222222222222222222222222222222",
    "evaluation_sha": "2222222222222222222222222222222222222222",
    "evaluation_kind": "head",
    "pr_state": "open",
    "required_checks": [
      {"context": "CI", "source": "check_run", "state": "failing", "evaluation_sha": "2222222222222222222222222222222222222222"}
    ]
  },
  "dependencies": {"all_completed": true, "predecessors": []},
  "children": {"total": 0, "completed": 0, "terminal_noncompleted": 0},
  "attempts": [{"attempt_id": "attempt_1", "ordinal": 1, "role": "implementation", "lifecycle": "running", "session_id": "ses_1", "start_revision": "1111111111111111111111111111111111111111", "turn": {"id": "turn_1", "state": "completed"}}],
  "blocker": null,
  "observations": [],
  "action_history": {"relevant": [], "continuation_fingerprints_sent": []},
  "budget_usage": {"attempts": 1, "continuations_by_reason": {}, "ci_retries": 0, "verifier_cycles": 0, "execution_ms": 30000, "grants": []},
  "retry_schedule": {"due_at_ms": null, "cause": null},
  "merge_wait_due_at_ms": null
}
```

**Read transaction:** all durable DB-derived fields represent one SQLite snapshot. A separately collected observation has its own provenance, collection sequence, freshness and exact Git revision/evaluation SHA. The repository must not synchronously call OpenCode/GitHub while assembling a snapshot.

**Semantic hash:** canonical JSON with unordered maps/sets sorted, excluding `logical_time_ms`, volatile `recorded_at`, poll-only timestamps/sequence churn and decision-audit metadata. Do not exclude meaningful health/freshness/due-time facts. The evaluator always receives `logical_time_ms` separately for expiry/deadline checks.

**No-progress and dedupe:** `action_history` includes each relevant prior `(action_kind, attempt_id, cause_fingerprint, idempotency_key, state, turn_id)` and the last consumed evidence. Enough information to avoid resending an unchanged ChecksFailed reason. Action history must be bounded in the snapshot but the full ledger is retained outside it.

**Aggregate completion:** AllChildrenCompleted requires at least one declared child, all direct children Completed, and no post-terminal child additions. An aggregate root with zero children is not vacuously complete. All predecessor dependencies must be completed to make an executable Task runnable.

## 4. Pure reconciler port (56-owned)

```rust
// Conceptual signature; adapt to established project names, not semantics.
fn reconcile(snapshot: &TaskSnapshot, now: LogicalTime) -> Decision {
    // Decision { rule_id: String, desired_actions: Vec<ProposedAction>, attention: Vec<AttentionReason> }
}
```

No I/O, DB reads, nondeterministic randomness, current wall clock, OpenCode calls or provider calls. Completions are evaluated before continuations, including when the Task is held. `rule_id` is a stable recorded reason and drives a future UI.

`ProposedAction` includes:
```text
kind, task_id, attempt_id?, cause_fingerprint, idempotency_key, class, payload
```

`CreateAttempt` key = hash(task_id, role, **ordinal**), never mutable Task version.
Continuation key = hash(task_id, attempt_id, action_kind, exact cause fingerprint).
Action ordering is stable, deterministic. `UnknownOutcome` SendTurn is never blindly resent.

`DecisionRecord` includes `schema_version`, `reconciler_version`, `task_version`, `logical_time_ms`, `snapshot_hash`, `actions_hash`, `rule_id`, and canonical snapshot/actions JSON. `GET /v1/tasks/{id}/decisions` returns persisted records.

## 5. Repository/store and effect ports

55 must expose the following *behaviors* via its store (names may adapt to existing Rust style, but payload/schema are frozen):

```rust
trait TaskReadPort {
    fn task_snapshot(&self, task_id: &TaskId, now: LogicalTime) -> Result<TaskSnapshot, StoreError>;
}
trait TaskWritePort {
    fn compare_and_set_controller_mode(&self, task_id: &TaskId, expected_version: u64, next: ControllerMode) -> Result<(), StoreError>;
    fn complete_with_trusted_evidence(&self, task_id: &TaskId, expected_version: u64, evidence: Vec<TrustedEvidenceRef>) -> Result<(), StoreError>;
    fn propose_or_claim_attempt(&self, task_id: &TaskId, role: AttemptRole, ordinal: u32, idempotency_key: &str) -> Result<AttemptAdmission, StoreError>;
}
enum AttemptAdmission { Claimed(AttemptId), DeferredCapacity }
```

Do **not** expose a worker-facing `complete_task` mutation. Trust assertions and terminal transitions belong in 55's domain/store layer.

56 owns `DecisionStorePort` / Action outbox implementation, which is **atomic**: CAS current authorized-action generation, compare desired key set, record decision, insert-or-ignore keys, supersede only unclaimed no-longer-desired actions. A no-op periodic wake does not revoke in-flight actions or generate a new audit row. An external side effect already dispatched cannot be undone by fencing; recover it through observation.

**Controller ownership:** legacy or shadow Tasks cannot dispatch reconciler effects. Shadow can record decisions. Cutover adopts healthy in-flight sessions/Attempts and fences legacy completion/dispatch. A capacity deferral consumes neither budget nor Attempt.

**Observer:** separate loop persists poll due/backoff and monotonic collection sequence before fetching. Store head SHA and evaluation SHA separately. GitHub statuses/check runs and required-check policy resolve to `pending/passing/failing/unknown`. Only provider-observed merge supplies PullRequest `delivery_complete`.

## 6. Public HTTP/API surface (55 first; 56 extends)

55 owns the first-class Task routes:
```text
POST /v1/tasks
GET  /v1/tasks?lifecycle=open&parent=<id>&runnable=true
GET  /v1/tasks/{id}
GET  /v1/tasks/{id}/snapshot
POST /v1/tasks/graph
GET  /v1/tasks/{id}/attempts
GET  /v1/attempts/{id}
POST /v1/tasks/{id}/cancel
POST /v1/tasks/{id}/obviate
POST /v1/tasks/{id}/budget-grants
POST /v1/tasks/{id}/controller-mode
POST /v1/attempts/{id}/blockers
POST /v1/tasks/{id}/blockers/{blocker_id}/resolve
```

55 preserves current batch routes and routes them through canonical Task identity. 56 extends, without replacing Task routes:
```text
GET /v1/tasks/{id}/decisions
GET /v1/tasks?attention=true
```

For mutations, use existing `Idempotency-Key` policy and CAS/409 mismatch semantics. Cursor pagination for history; `GET snapshot` is a **read**, not a provider refresh. No UI-only alternate transition endpoints.

## 7. Golden fixture tests and integration acceptance

- 55 publishes `tests/fixtures/task-snapshot-v1/*.json` early. Include at least: fresh open executable, failed required checks with prior continuation, healthy merged PR with stale red checks, operator hold, unresolved blocker, budget exhaustion, dependency noncompleted terminal, missing PR branch, shadow owned in-flight attempt, empty aggregate root, and merge-group SHA mismatch.
- 56 tests `reconcile(snapshot, logical_time)` against those fixtures before a real store is ready; fixtures are not a separate production schema.
- Both lanes check consistent serde round-trip, exact SHA binding, generation no-op stability, and action idempotency.
- 56's R1c end-to-end integration and controller authority cutover **wait until 55's canonical store/API lands**. Its R1a/R1b kernel/adapter work does not.
- Verify pinned OpenCode v1.18.30 ambiguous SendTurn recovery, legacy/shadow cutover, and named failpoints before enabling R1 production autonomous execution.
- Commands: `nix develop -c just check` and `nix develop -c just e2e`. Never substitute `nix --option build-users-group ""`.

## 8. Git isolation, PRs and convergence

- Both agents start at current `main`, independently, with descriptive session names and their own work branches.
- 55 edits canonical domain/store/Task API and fixture files.
- 56 edits new reconciler/adapter/test-world modules. It may extend `Cargo.toml` to add its standalone crate, but **must not edit 55-owned Task store/core/lib integration code in its first PR**.
- Each opens a PR early with its plan/progress. Small commits with coherent verification. Both should use regular SDLC merge queue; avoid manually modifying/merging another agent's PR.
- When 55's first typed DTO contract commit is published, 56 checks for serialization drift and reports any mismatch immediately; shared API changes require coordination, not unilateral patches.
- 56's final R1c wiring/integration is a follow-up commit/PR only after the 55 store/API merge. Keep the overall ANVIL-56 Lific issue open until end-to-end done.
