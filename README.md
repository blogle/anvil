# Anvil

A control plane and operator loop that drives [opencode v2](https://opencode.ai)
coding agents inside quarantined sandboxes (podman locally, kubernetes
agent-sandboxes in production) toward **merged GitHub pull requests** — unattended.
Campaigns decompose into commissions: durable, one-repo/one-PR convergence tasks
with explicit obligations, verified by PR checks, surfaced to humans only through
a deterministic inbox.

Experimental (0.x). This implementation supersedes an incumbent of the same name.

- [Specification](docs/spec.md) — normative MUSTs and invariants
- [Architecture](docs/architecture.md) — structure and decisions
- [Research](docs/research.md) — prior-art digests
- `just docs` — serve the documentation with live reload
- Work is tracked on the ANVIL board (lific), modules `M1`–`M4`
