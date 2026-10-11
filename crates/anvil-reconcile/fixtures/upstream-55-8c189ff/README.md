# Pinned ANVIL-55 compatibility fixtures

All eleven snapshot files are copied from PR #80 head `8c189ff1723096d5ac212ef47349ce0816a5ddd7`, path `crates/anvil-core/tests/fixtures/task-snapshot-v1/`. They preserve the canonical wire shapes, including legacy snapshots whose `budget_usage.limits` field is omitted. The #55 DTO declares finite `TaskBudget::default()` serde defaults for those ungranted snapshots; a snapshot with grants but no effective limits is rejected. Missing action-history availability remains unknown, never authoritative-empty.
