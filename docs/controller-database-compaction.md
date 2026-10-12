# Controller database compaction and rollout

The controller store automatically performs a one-time, versioned change-log compaction
on startup. `ControllerStore::open` runs it before `anvild` binds its listener; any error
fails startup closed. It prunes `orchestration_changes` in committed batches to the latest
10,000 sequences, checkpoints WAL, uses `VACUUM INTO` to build a staged database, validates
integrity, foreign keys, row cap, and stream high-watermark, then atomically replaces the
source. A hard-link rollback copy retains the old file's blocks until the compacted file
has been reopened and validated and the completion marker committed. Canonical tasks,
attempts, decisions, idempotency, evidence, outbox state, and session materializations are
not pruned.

The base `anvild` Deployment uses Kubernetes `Recreate`: the old writer is terminated
before the new pod starts the startup migration. Do not change this to a rolling surge
unless an equivalent exclusive-writer guarantee is proven. Prune batches commit their
cursor floor, so startup resumes after termination. A staged database interrupted before
replacement is discarded and rebuilt; replacement is a same-filesystem atomic rename. If
the process stops after replacement but before the marker, the next startup validates the
capped database and records completion without repeating `VACUUM INTO`. No recurring
compaction runs after the marker is committed.

## Capacity and expected size

`VACUUM INTO` requires scratch space for the compacted live database; the source remains
untouched until the staged file is validated and atomically installed. The hard-link
rollback does not copy source blocks. With a 10,000-row cap and observed 5–14 KiB
snapshots, retained event payload is approximately 50–140 MiB, plus indexes and other
durable records. Startup checkpoints WAL before `VACUUM INTO` to avoid a large WAL spike.
The 64 GiB current PVC provides headroom for the source, compacted temporary database,
existing history, and operational margin. If the filesystem cannot accommodate the
staged output, startup fails closed and leaves the source database untouched.

The incident baseline supplied for 2026-10-12 was 26.13 GiB logical with a 26,620.8 MiB
change table, 132.8 MiB index, 0.4 MiB materialization table, and 1.2 MiB WAL. A
production-like synthetic fixture with 24,000 12-KiB historical snapshots measured
308,285,440 bytes (294.0 MiB) before and 128,569,344 bytes (122.6 MiB) after compaction,
a 58.3% file-size reduction. The test asserts at least 50% shrink and a result below 1 GiB
while retaining the latest 10,000 changes and durable records. Monitor actual database,
WAL, and `history.jsonl` usage after deployment before changing storage capacity.

## Follow-up after stability

PVC capacity cannot be reduced in place. Keep the live 64 GiB `anvil-history` PVC through
compaction and observation. A separate GitOps change will need to provision a new smaller
PVC, stop writers, verify and migrate the compacted database plus `history.jsonl`, switch
the claim, and retain rollback data. The existing restoration/expansion is handled by
`blogle/dotfiles#120`; this Anvil change does not edit its overlay or shrink the claim.

`history.jsonl` is retained: session activity reads its prompt/lifecycle events. Its
diagnosed size is small and it is not part of this incident.

## Poll-driven change source

`GET /v1/sessions` (`enumerate`) and `GET /v1/sessions/:id` (`session`) call
`reconcile_binding`. On a healthy binding, the old path wrote a transient `recovering`
state and then `available` on every poll, each with a fresh `checked_at`. The
`MaterializingSandboxApi` writes made `binding_state.checked_at` and its duplicate
`session.session_binding_checked_at` appear as semantic changes. `telemetry.last_activity_at`
is not the cause; production samples showed it unchanged. Reconciliation now probes first,
does not persist the transient state, and writes a final binding record only when state,
continuity, error, previous session ID, or recovery event changes. The materialized stream
also excludes both sample-time fields. Real binding recovery and telemetry transitions
continue to be recorded.
