# Design Intent

This repository is a clean starting point for Anvil v2. It should become a dependable Rust project with a small, understandable implementation and reproducible development tools.

Phase 1 explores durable task-centric workflows, deterministic reconciliation, isolated agent sandboxes, and an MCP API; architecture follows research rather than preceding it.

## Principles

- Keep the initial design smaller than the problem statement.
- Prefer explicit, testable behavior over implicit runtime machinery.
- Keep builds reproducible and development checks easy to run locally.
- Treat operational and security constraints as design inputs, not afterthoughts.

## Open Questions

- What is the smallest useful v2 user-facing capability?
- Which execution and persistence boundaries are actually required?
- What compatibility, if any, should v2 provide with prior Anvil deployments?
