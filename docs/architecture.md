# Architecture

Anvil is an OpenCode orchestration boundary for Kubernetes Agent Sandbox. The
application namespace is `anvil`; the Agent Sandbox controller and router are
cluster prerequisites and are deliberately not owned by this repository's
application kustomizations.

`anvild` is the only workload with Kubernetes API credentials. Its `anvild`
service account is bound to a namespaced Role that can act only on
`sandboxes.agents.x-k8s.io` in `anvil`. It has no permissions for Pods,
Secrets, RBAC objects, other namespaces, or other API groups.

`anvil-mcp` and `anvil-router` are internal HTTP services. Their pods set
`automountServiceAccountToken: false`, and the manifests define neither
`KUBECONFIG` nor mounted Kubernetes credential material for them. The router
is the wildcard Ingress target; it reaches internal services over ClusterIP
DNS. Traefik applies the already-observed `auth/sso-auth` and `auth/sso-errors`
middlewares through cross-namespace CRD references.

The `k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml` asset is evidence and a
reproducible input for a platform administrator. It is intentionally absent
from `k8s/base/kustomization.yaml`; rendering or applying Anvil does not
install, upgrade, or modify upstream Agent Sandbox.

## Prerequisites and current block

The observed live cluster has Agent Sandbox controller `v0.5.3`, while Anvil
targets `v1.0.2`; the required Sandbox Router is also absent. This is a hard
compatibility block. Do not apply the vendored upstream manifest, direct an
in-place upgrade, or infer that the v0.5.3 CRDs/controllers are API-compatible.
A platform owner must evaluate the upstream upgrade and router installation
separately, with backup, compatibility, and rollback plans. No live-cluster
operation is part of this repository.
