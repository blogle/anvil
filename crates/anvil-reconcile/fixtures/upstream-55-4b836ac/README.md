# Pinned ANVIL-55 compatibility fixtures

The two snapshots here are copied from PR #80 head `4b836ac8f06309c6facf45bdce51e848deb8173c`, from `crates/anvil-core/tests/fixtures/task-snapshot-v1/`. They retain the canonical `budget_usage.limits` and `action_history` JSON shapes. The fixture's missing action-history availability is intentionally preserved as unknown; tests must attach an authoritative read-port result before expecting a dispatch.
