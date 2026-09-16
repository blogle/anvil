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

## OpenCode profile

Anvil has one persistent OpenCode profile at `/anvil/profile`. The profile
contains global OpenCode configuration and administrator-managed provider
credentials, plus shared agents, commands, skills, and plugins. Individual
session databases, conversations, logs, working trees, and project state remain
on each Sandbox's private `/workspace` claim.

```text
anvilctl -> anvild -> anvil-profile (singleton OpenCode server)
                         |
                  anvil-opencode-profile PVC
                         |
              +----------+----------+
              |                     |
           Sandbox A             Sandbox B
           OpenCode              OpenCode
```

The profile OpenCode service is ClusterIP-only and is never exposed through the
preview Ingress. Its NetworkPolicy permits port 4096 only from `anvild`, and
the profile pod has no Kubernetes service-account token. `anvild` is its only
normal client. Workers receive
`OPENCODE_CONFIG=/anvil/profile/config/opencode.jsonc` and
`OPENCODE_CONFIG_DIR=/anvil/profile/config`. Their private
`/workspace/home/.local/share/opencode/auth.json` is a symlink to the shared
profile auth file; no other OpenCode data directory is shared. Existing local
worker auth files are preserved rather than overwritten. The current
single-node RWO fallback necessarily gives worker pods access to the mounted
profile contents so OpenCode can refresh credentials; treat Anvil sandboxes as
trusted until a mediated profile distribution mechanism replaces this PoC.

## Storage access decision

The required live checks reported one node (`nandstorm`), OpenEBS ZFS CSI
(`zfs.csi.openebs.io`), and only `Persistent` CSI volume modes. Existing ZFS
PVCs are `ReadWriteOnce`; RWX is not available. Anvil therefore uses the
`anvil-opencode-profile` PVC with `ReadWriteOnce` on this deliberately
single-node homelab. Multiple pods can mount it because they remain on the same
node, but this is not a portable multi-node deployment. A future multi-node
deployment needs an RWX-capable backend or a profile distribution service.
