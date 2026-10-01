# Wide-batch acceptance status

This document tracks the ANVIL-22 acceptance harness against current `main`.
The executable tests drive `anvild`'s real HTTP routes with deterministic
requests and local fake infrastructure only for repository commit resolution;
they do not send prompts to a model or synthesize orchestration through the
generic idempotency store.

## Implemented assertions in this branch

`public_wide_batch_api_is_idempotent_durable_and_base_stable` uses
`wide_batch_fixture_plan(count)` for 20, 50, and 100 requested Tasks and
exercises `POST /v1/batches`, `GET /v1/batches/{id}`, `GET /v1/tasks/{id}`,
`POST /v1/tasks/{id}/attempts`, and `GET /v1/tasks/{id}/attempts` through the
public router. It verifies:

- each complete plan is submitted in one HTTP operation and the acceptance
  response stays within the 64 KiB request/response budget;
- one key/request replay returns the original batch identity, while conflicting
  reuse returns HTTP 409;
- a mocked repository resolver supplies a single immutable full commit, which
  is shared by all 100 accepted Tasks;
- controller acceptance exposes queued/runnable counts and each retrieved Task
  has controller-owned `queued` state;
- the compact batch acceptance response does not inline prompts, messages,
  transcripts, logs, or diffs; detail is followed by stable Batch/Task/Attempt
  IDs through their actual GET routes;
- stable Batch, Task, and Attempt IDs can be followed through the existing GET
  routes; attempt creation is idempotent and currently reports `queued`;
- Batch, Task, and Attempt records plus the submission binding survive opening a
  new `AppState` over the same SQLite store; retry after reopen replays the same
  Batch.

`first_snapshot_after_restart_reconciles_stale_materialization` exercises the
existing `GET /v1/changes` opaque session-state cursor through its snapshot,
changed-only delta, tiny no-change response, and reopen/re-read paths. These
cursor assertions cover materialized session state, not Batch/Task/Attempt
changes.

## Pending production surfaces (dependent on #20 / #22)

The acceptance remains incomplete and PR #18 stays draft until these actual
controller/API capabilities land and can be tested end-to-end:

| Pending case | Missing production surface |
| --- | --- |
| Controller-managed queue capacity, provisioning retry bounds, and autonomous dependency scheduling | Queue/capacity/retry controller and observable public state from #20 |
| Fleet batch digest with counts, exceptions, retry/review candidates, operator/debug projection and stable detail references | Compact digest/read projection from #22, including its projection of existing Git/workspace detail surfaces |
| Changed-since delta containing Batch/Task/Attempt materializations, tied to the same wide-batch fixture | Orchestration-resource digest/delta integration from #22; current `/v1/changes` exposes session materialization only |
| Response-size regression for task digest and batch no-change/small-change deltas at 20/50/100 | The digest/delta response routes from #22 |

The current batch acceptance's `queued` state is not evidence of controller
capacity management or provisioning retry. The session cursor's no-change
response does not stand in for a batch digest no-change response. No worker
prose is used to infer lifecycle, and deterministic controller-run quality or
evidence gates remain out of scope.
