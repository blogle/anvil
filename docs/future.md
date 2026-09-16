# Future Work

The deployment assets deliberately stop at a safe application boundary. Future
work, after platform compatibility is established, includes:

* Add concrete `anvild`, MCP, and router image build/release references once
  the services exist; retain immutable production image digests.
* Define real probes, route contracts, and NetworkPolicies from implemented
  service behavior instead of speculative configuration.
* Have the platform team separately assess Agent Sandbox v1.0.2 migration,
  compatible Sandbox Router deployment, CRD conversion/storage effects,
  runtime-class requirements, backups, and rollback.
* Add environment-specific TLS, hostname, and secret references through
  reviewed overlays. Secrets and Kubernetes credentials must remain absent from
  MCP and router pods.
* Add policy and render validation in CI after the repository adopts a CI
  workflow; no root build tooling was changed for these assets.

Do not turn the vendored upstream manifest into an application resource. It is
kept to pin and audit the required platform release, not to make Anvil an
installer for a cluster-scoped controller.

* Replace the single-node `ReadWriteOnce` profile PVC assumption with an
  RWX-capable backend or a dedicated profile distribution service before
  multi-node scheduling.
* Centralize OpenCode OAuth refresh handling. Multiple sandboxes can currently
  read/write the shared `auth.json`; simultaneous rotation of one OAuth refresh
  token can race. Anvil intentionally does not add a credential broker,
  distributed lock, or OpenCode patch in this PoC.
* Add safe shared-profile configuration mutation and provider logout after the
  installed OpenCode API exposes a reliable credential-removal operation.
