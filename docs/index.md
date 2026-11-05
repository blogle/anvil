# Anvil project notes

This branch starts from the deployed mainline implementation and is reserved for
planning an incremental adaptation toward a future architecture. The existing
system remains the capability baseline; this documentation reset does not imply
that a rewrite, migration, or production change has been approved.

## Documents

- [Controller spec](spec.md): a one-page limit and the decisions awaiting the
  user's vision discussion.
- [Incremental roadmap](roadmap.md): documentation, inventory, phased changes,
  and evidence from an isolated deployment.
- [Deployment guardrails](deployment.md): isolation and non-interference rules.

## Current branch boundary

This branch is documentation-only until the vision discussion produces an
approved spec. Preserve mainline behavior while deciding what to keep, adapt, or
remove. Any implementation phase must be small enough to build, deploy to an
isolated namespace, observe, and revise before the next phase.
