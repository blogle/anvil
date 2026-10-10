# ANVIL-55 implementation plan

1. Extend `anvil-core` with the canonical typed Task, Attempt, evidence, terminal, controller, and snapshot vocabulary; keep policy decisions pure.
2. Add a forward-only transactional SQLite migration over the existing batch/task/attempt tables. Preserve identities and session/idempotency bindings; add durable Task metadata, graph, observation sequencing/history, blockers, grants, and uniqueness/CAS support.
3. Route first-class Task operations through the existing store and scheduler, retaining Batch as optional submission/capacity grouping and retaining the legacy scheduler as the Legacy controller.
4. Add focused migration mapping, restart, ordering, CAS, uniqueness, and scheduler-cutover tests; expose compatible first-class API routes.
5. Run formatter, workspace checks, migration/E2E suites; open a reviewable ANVIL-55 PR with spec links.

Scope boundary: establish durable data/API contracts only. Do not implement R1 reconciliation, Lific polling, provider integrations, verifier execution, or UI redesign.
