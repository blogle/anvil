# Anvil

Anvil supervises OpenCode work on Kubernetes Agent Sandbox. The existing
mainline implementation is the baseline for an incremental architecture update;
this branch begins with documentation only.

## Start here

- [Project and current direction](docs/index.md)
- [Controller spec status](docs/spec.md) — intentionally awaiting the vision
  discussion; target spec is limited to one page.
- [Incremental roadmap](docs/roadmap.md)
- [Isolated deployment guardrails](docs/deployment.md)

The first deployment of any changed implementation must use a separately
authorized, temporary Kubernetes namespace. Do not alter or interrupt the
production deployment while this work is being evaluated.
