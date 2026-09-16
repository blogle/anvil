# Agent Sandbox v1.0.2 vendor provenance

`sandbox.yaml` is the unmodified core release asset from Kubernetes SIG Apps
Agent Sandbox. It is retained as evidence of the API/controller version that
Anvil requires; it is **not** referenced by an Anvil kustomization and must
not be applied as part of an Anvil deployment.

* Source: https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.2/sandbox.yaml
* Release: https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v1.0.2
* Tag: `v1.0.2`
* Annotated tag object: `468cf30617c01e30098d631a2bdd8d032f8359e4`
* Tagged commit: `9a85153590e54cb980f3241f9e7a9228449412c9`
* Downloaded release-asset SHA-256: `5daf76bba85ba656a8877c9bcce1c9598bd124a61875b59b4256095fdbf1fcdb`
* GitHub release-asset size: `205215` bytes
* Retrieval date: 2026-09-15

Verify the vendored file without a cluster connection:

```sh
(cd k8s/vendor/agent-sandbox/v1.0.2 && sha256sum -c SHA256SUMS)
```

The expected digest is the value above. The upstream tag is unsigned according
to GitHub's tag API; the release-asset digest is the integrity check used here.
