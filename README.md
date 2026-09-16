# anvil

OpenCode orchestration on Kubernetes Agent Sandbox.

## Kubernetes assets

The application manifests live under `k8s/`. `k8s/base` creates the `anvil`
namespace, `anvild` service account and narrowly scoped Sandbox RBAC, runtime
configuration, the `anvild`/MCP/router Deployments and Services, and a
Traefik wildcard Ingress. `k8s/overlays/dev` selects the development hostname.
All images use `imagePullPolicy: Never` and therefore must be present locally
on eligible nodes.

The pinned, unmodified Agent Sandbox v1.0.2 core release asset is vendored at
`k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml`. It is not a Kustomize resource:
Anvil does not install or change Agent Sandbox. Its provenance and checksum are
in the adjacent README.

The currently observed cluster is blocked: it has controller v0.5.3, not the
required v1.0.2, and has no Sandbox Router. Do not apply the vendor asset or
attempt an unsafe upgrade. See [architecture](docs/architecture.md),
[runtime/API contract](docs/api.md), [development](docs/development.md), and
[future work](docs/future.md) for boundaries and compatible-cluster checks.
