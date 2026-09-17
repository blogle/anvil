# anvil

OpenCode orchestration on Kubernetes Agent Sandbox.

## Kubernetes assets

The application manifests live under `k8s/`. `k8s/base` creates the `anvil`
namespace, `anvild` service account and narrowly scoped Sandbox RBAC, runtime
configuration, the persistent OpenCode profile PVC, the singleton
`anvil-profile` OpenCode Deployment/Service, the `anvild`/MCP/router
Deployments and Services, and a Traefik wildcard Ingress. `k8s/overlays/dev`
selects the development hostname.
The normal deployment pulls public images from `ghcr.io/blogle/anvil` and
`ghcr.io/blogle/anvil-sandbox`. The GitHub Actions workflow publishes immutable
SHA tags plus the `main` and `latest` tags.

The pinned, unmodified Agent Sandbox v1.0.2 core release asset is vendored at
`k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml`. It is not a Kustomize resource:
Anvil does not install or change Agent Sandbox. Its provenance and checksum are
in the adjacent README.

The currently observed cluster is blocked: it has controller v0.5.3, not the
required v1.0.2, and has no Sandbox Router. Do not apply the vendor asset or
attempt an unsafe upgrade. See [architecture](docs/architecture.md),
[runtime/API contract](docs/api.md), [development](docs/development.md), and
[future work](docs/future.md) for boundaries and compatible-cluster checks.

## Operator client

Build or install the `anvilctl` package, set `ANVIL_URL` (or pass `--server`),
then authenticate Anvil once:

```sh
anvilctl providers list
anvilctl providers login openai
anvilctl providers login opencode-go --method api
anvilctl sessions create --project dojo2 --repository https://github.com/blogle/dojo2.git --ref main --prompt "Inspect the repository."
```

Provider credentials and global OpenCode configuration are shared through the
Anvil profile. Each sandbox retains its own checkout, home, session database,
conversation, logs, and working tree. `just` is reserved for development and
deployment workflows; `anvilctl` is the operator interface.
