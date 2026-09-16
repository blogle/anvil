# Development Deployment
Render without contacting a cluster:

```sh
kubectl kustomize k8s/overlays/dev
```

The development overlay remains in the `anvil` namespace, retains
`imagePullPolicy: Never`, and changes only the wildcard host to
`*.anvil.test`. Build or load the three local images into every target node
before any platform-approved deployment. The repository intentionally provides
no apply script and this document does not instruct applying to the current
cluster.

Before a platform owner considers a deployment, independently verify all of:

* Agent Sandbox v1.0.2 CRDs and controller are installed and healthy.
* The compatible Sandbox Router exists at
  `sandbox-router.agent-sandbox-system.svc.cluster.local`.
* Traefik supports `traefik.ingress.kubernetes.io/router.middlewares` and the
  observed `auth/sso-auth` and `auth/sso-errors` Middleware CRDs exist.
* Each node that can schedule Anvil has the three `:dev` images.

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
