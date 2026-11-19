# Changelog

## [0.1.0] - 2026-11-19

- **feature**: Engine: cadence tick loop with the commission state machine (exhaustive transition table), wave admission with the escalated skip-gate, and MVP detectors (heartbeat/turn timeouts, attempt budget exhaustion) — transitions write state, events, and attention atomically.
- **feature**: SQLite persistence layer: domain vocabulary in anvil-api and the store module in anvild (WAL-tuned, append-only event log with cursor semantics, deterministic attention items, explicit failures on missing rows).
- **feature**: Scaffold the five-crate Cargo workspace and wire the SDLC CI contract: crane check/verify stages, per-member packages, caller workflows, and repository policy.
