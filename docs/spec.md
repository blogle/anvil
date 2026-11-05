# Controller spec

**Status: not drafted.** This page deliberately records the current guardrails,
not an assumed product vision. Draft the controller spec with the user before
changing application code. Keep the approved spec to approximately one page; move
implementation sequencing to the roadmap rather than growing the spec into a
design archive.

## Agreed direction

- Start from the existing mainline implementation and adapt it incrementally
  toward the future architecture; do not presume a greenfield rewrite.
- Preserve useful, already implemented behavior unless the agreed target gives a
  concrete reason to change it.
- Develop in observable phases. Build, deploy, inspect real behavior, and use
  those findings to choose the next change instead of implementing hypothetical
  requirements in advance.
- Keep all changed deployments in a temporary, isolated Kubernetes namespace
  until the user and operators determine that the implementation is proven.
- Do not interfere with production deployment, data, credentials, or availability.

## To resolve in the vision discussion

Define the controller's core responsibilities and boundaries; the capabilities
that must remain; what the future architecture changes; how operators interact
with and observe work; and what evidence permits each rollout step. These are
open decisions, not requirements inferred by this branch.

After the discussion, replace this status page with the concise approved
controller spec and record its acceptance in the roadmap. No code or deployment
work is authorized by this placeholder.
