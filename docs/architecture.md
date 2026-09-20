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
is intended to be the wildcard Ingress target; an environment overlay supplies
the Ingress, Certificate, storage class, and platform-specific middleware. It
reaches internal services over ClusterIP DNS.

The `k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml` asset is evidence and a
reproducible input for a platform administrator. It is intentionally absent
from `k8s/base/kustomization.yaml`; rendering or applying Anvil does not
install, upgrade, or modify upstream Agent Sandbox.

## Prerequisites

An Anvil environment requires a compatible Agent Sandbox controller and
Sandbox Router, plus a storage class that supports the profile PVC and each
generated Sandbox workspace PVC. These are platform prerequisites and are not
installed by Anvil. The vendored upstream manifest is a reproducible reference
for the required Agent Sandbox release; it must not be applied as part of the
application base.

## OpenCode profile

Anvil has one persistent OpenCode profile at `/anvil/profile`. The profile
contains global OpenCode configuration and administrator-managed provider
credentials, plus shared agents, commands, skills, and plugins. Individual
session databases, conversations, logs, working trees, and project state remain
on each Sandbox's private `/home/anvil` claim.

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
`/home/anvil/.local/share/opencode/auth.json` is a symlink to the shared
profile auth file; no other OpenCode data directory is shared. Existing local
worker auth files are preserved rather than overwritten. The current
single-node RWO fallback necessarily gives worker pods access to the mounted
profile contents so OpenCode can refresh credentials; treat Anvil sandboxes as
trusted until a mediated profile distribution mechanism replaces this PoC.

Each newly-created Sandbox mounts its workspace PVC at `/home/anvil`, checks out
the repository at `/home/anvil/workspace/<project>`, and stores OpenCode's
native database and XDG state in the standard paths below that PVC. The
controller marks this runtime layout as `v2`; existing Agent Sandbox resources
are immutable and retain their legacy layout until deleted.

`anvild` verifies the durable OpenCode session ID after startup, resume, and
before session operations. If the exact ID still exists, it is always retained.
If OpenCode definitively returns 404 for the ID, Anvil automatically creates a
replacement, records both IDs and lost continuity in annotations and history,
and continues the operation without a user-facing rebind step. Transport or
health failures remain errors and never trigger replacement. The explicit
`rebind` route remains an operator escape hatch only.

The profile also installs the small `anvil_report` OpenCode plugin. It injects a
single end-of-turn instruction and reports only `ready_for_review` or
`awaiting_input` through the Sandbox's existing session capability. It cannot set
environment or execution state, complete a session, or choose an arbitrary state.

## Storage access decision

The profile and generated workspaces use `ReadWriteOnce` by default. Multiple
pods can mount the shared profile only when the selected storage backend and
scheduling topology support it. A multi-node deployment needs an RWX-capable
backend or a profile distribution service.
