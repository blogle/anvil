# Development Deployment
Render without contacting a cluster:

```sh
kubectl kustomize k8s/overlays/dev
```

The development overlay remains in the `anvil` namespace and renders the
portable base with placeholder preview values. It pulls the public `main`
images from GHCR; immutable SHA tags should be selected by an
environment-specific overlay for a controlled deployment. Hostnames, TLS,
Ingress, middleware, storage classes, and platform service URLs belong in that
overlay.

Before a platform owner considers a deployment, independently verify all of:

* Agent Sandbox v1.0.2 CRDs and controller are installed and healthy.
* The compatible Sandbox Router exists at
  `sandbox-router.agent-sandbox-system.svc.cluster.local`.
* Each node that can schedule Anvil can pull the two required public GHCR
  images.

Only after those checks pass, a small, platform-owner-run smoke strategy is:

```sh
kubectl kustomize k8s/overlays/dev | kubectl apply --dry-run=server -f -
kubectl auth can-i --as=system:serviceaccount:anvil:anvild create sandboxes.agents.x-k8s.io -n anvil
kubectl auth can-i --as=system:serviceaccount:anvil:anvild get pods -n anvil
```

The first command is server-side validation only. The expected authorization
results are `yes` for Sandbox creation and `no` for Pod reads. Do not apply the
vendored Agent Sandbox asset through this repository.

## Operator workflow

After Anvil is deployed, use the client rather than `kubectl` or `just` for
normal administration:

```sh
anvilctl providers list
anvilctl providers login openai
anvilctl sessions list
anvilctl sessions create --project dojo2 --repository https://github.com/blogle/dojo2.git --ref main --prompt "Inspect the repository." --author-name "Developer Name" --author-email developer@example.com
```

`anvilctl --server URL` overrides `ANVIL_URL`. The client also supports
`--json` for scripting. `sessions attach` is the deliberate exception: it
queries `anvild`, then temporarily uses local `kubectl port-forward` and the
installed `opencode` binary to attach a TUI.

The shared profile is stored in `anvil-opencode-profile`, mounted at
`/anvil/profile`, and reused by the singleton `anvil-profile` deployment and
new Agent Sandboxes. The current ZFS storage is single-node `ReadWriteOnce`,
not RWX; do not schedule this PoC across multiple nodes.

## GitHub broker setup

Populate the `github-app-credentials` Secret through the deployment's secret
manager with these keys before enabling private-repository sessions:

* `ANVIL_GITHUB_APP_ID`
* `ANVIL_GITHUB_INSTALLATION_ID`
* `ANVIL_GITHUB_PRIVATE_KEY`
* `ANVIL_SESSION_SIGNING_SECRET` (at least 32 random bytes)

The Secret is referenced only by `anvild`. Sandboxes receive a signed,
session-bound capability and the internal broker URL, never the App private
key. Git and `gh` use the sandbox-provided `anvil-credential` helper and `gh`
wrapper to obtain short-lived repository-scoped installation tokens.

The opt-in acceptance harness checks the unprivileged user, XDG paths,
`/usr/bin/env`, Nix development loop, Xvfb, Chromium, Git identity, and (when
`ANVIL_ACCEPTANCE_GITHUB=1`) GitHub access:

```sh
ANVIL_SANDBOX_POD=... tests/sandbox-acceptance.sh
```
