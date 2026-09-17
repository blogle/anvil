# Development Deployment
Render without contacting a cluster:

```sh
kubectl kustomize k8s/overlays/dev
```

The development overlay remains in the `anvil` namespace and selects the
wildcard host `*.preview.thejeffer.net`. It pulls the public `main` images from
GHCR; immutable SHA tags should be selected by an environment-specific overlay
for a controlled deployment. The repository intentionally provides no apply
script and this document does not instruct applying to the current cluster.

Before a platform owner considers a deployment, independently verify all of:

* Agent Sandbox v1.0.2 CRDs and controller are installed and healthy.
* The compatible Sandbox Router exists at
  `sandbox-router.agent-sandbox-system.svc.cluster.local`.
* Traefik supports `traefik.ingress.kubernetes.io/router.middlewares` and the
  observed `auth/sso-auth` and `auth/sso-errors` Middleware CRDs exist.
* Each node that can schedule Anvil can pull the two required public GHCR
  images.

Only after those checks pass, a small, platform-owner-run smoke strategy is:

```sh
kubectl kustomize k8s/overlays/dev | kubectl apply --dry-run=server -f -
kubectl auth can-i --as=system:serviceaccount:anvil:anvild create sandboxes.agents.x-k8s.io -n anvil
kubectl auth can-i --as=system:serviceaccount:anvil:anvild get pods -n anvil
```

The first command is server-side validation only. The expected authorization
results are `yes` for Sandbox creation and `no` for Pod reads. Do not run this
against the currently observed incompatible cluster, and do not use it as an
upgrade procedure.

## Operator workflow

After Anvil is deployed, use the client rather than `kubectl` or `just` for
normal administration:

```sh
anvilctl providers list
anvilctl providers login openai
anvilctl sessions list
anvilctl sessions create --project dojo2 --repository https://github.com/blogle/dojo2.git --ref main --prompt "Inspect the repository."
```

`anvilctl --server URL` overrides `ANVIL_URL`. The client also supports
`--json` for scripting. `sessions attach` is the deliberate exception: it
queries `anvild`, then temporarily uses local `kubectl port-forward` and the
installed `opencode` binary to attach a TUI.

The shared profile is stored in `anvil-opencode-profile`, mounted at
`/anvil/profile`, and reused by the singleton `anvil-profile` deployment and
new Agent Sandboxes. The current ZFS storage is single-node `ReadWriteOnce`,
not RWX; do not schedule this PoC across multiple nodes.
