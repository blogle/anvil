# Run Anvil with Kubernetes Agent Sandbox

Install the Agent Sandbox v1.0.12 controller and its `agents.x-k8s.io/v1beta1`
`Sandbox` CRD. Run `anvild` inside the cluster with the namespace-scoped Role
in `deploy/agent-sandbox/rbac.yaml` bound to its service account. Install the
Role and binding in the namespace where the sandboxes should run.

Set the following environment on `anvild`:

| Variable | Value |
|---|---|
| `ANVIL_SANDBOX` | `agent-sandbox` |
| `ANVIL_SANDBOX_NAMESPACE` | Namespace with the Role and binding |
| `ANVIL_SANDBOX_IMAGE` | Registry reference or digest for the sandbox image |
| `ANVIL_BIND` | Address reachable by the daemon's Kubernetes Service, e.g. `0.0.0.0:8788` |
| `ANVIL_ADVERTISE_URL` | In-cluster URL of that Service, reachable by sandbox pods |
| `ANVIL_SECRET_KEY` | Provision through a Kubernetes Secret, as for local deployments |

Use a persistent `ANVIL_DB` and a default StorageClass that supports
`ReadWriteOnce` claims. Sandbox nodes must provide `/nix/store` and
`/nix/var/nix/daemon-socket`; schedule the workload only on nodes that provide
that Nix setup. The daemon reaches OpenCode over the controller-created
service; agents signal back through `ANVIL_ADVERTISE_URL`.

Anvil creates a PVC for the workspace. Recreating the Sandbox on retry keeps
that claim and provisions fresh launch inputs. Deleting the Sandbox after
terminal grace also removes the backing pod, service, and launch Secret;
the workspace claim is retained for operator recovery and can be removed
separately. Launch files are mounted read-only, so credential files supplied
this way must be refreshed by the operator before retries if they expire.

`just agent-sandbox-smoke` uses a disposable Kind cluster and a dedicated
kubeconfig. It checks real controller readiness, OpenCode session creation,
shared Nix access, completion signaling to an in-cluster daemon, credential
replacement, workspace persistence, and terminal teardown. It does not
require a model subscription or submit a model-backed prompt.
