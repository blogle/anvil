# Anvil

Anvil is a control plane and operator loop that drives opencode v2 coding agents
inside quarantined sandboxes (podman locally, kubernetes agent-sandboxes in
production) toward merged GitHub pull requests — unattended. Operators submit
campaigns; commissions converge durably; human attention is budgeted through a
deterministic inbox.

This documentation is the system of record for the anvil-next implementation.

| Page | Content |
| --- | --- |
| [Specification](spec.md) | Normative MUSTs and invariants; WIP current design quarantined |
| [Architecture](architecture.md) | Packages, modules, dependency rules, type invariants, decision log |
| [Walkthrough](walkthrough.md) | Guided codebase tour: layout, packages, the loop, the seams, the tests |
| [Mockups](mockups/inbox.html) | Non-normative UI sketches: [inbox](mockups/inbox.html) · [campaign](mockups/campaign.html) · [commission](mockups/commission.html) |
| [Research](research.md) | Prior-art digests that informed the spec |

Serve this documentation with live reload:

```sh
just docs        # nix run .#docs -- --root docs --project .
```

Development work is tracked on the ANVIL board (lific), modules `M1`–`M4`.
Implementation follows the software-craft skill (`skills/software-craft/SKILL.md`).
