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
The broker accepts the server-defined `git`, `gh_read`, and `gh` credential
purposes; the Git helper requests `git`, which is limited to Contents write
access, while the new `gh` wrapper requests `gh`, which adds pull-request write
access to its otherwise read-only profile. `gh_read` remains available for
older read-only wrappers. Requests without a purpose use an explicit legacy
profile matching the pre-purpose authority so old Git and `gh` clients continue
to work during rollout. New sandbox images must be rolled out before removing
or changing that compatibility behavior. The GitHub App installation must grant
Pull requests: write for the `gh` profile; GitHub returns HTTP 422 when that
installation permission has not been approved.
GitHub API failures retain their status, safe message, request ID, and
documentation URL.

The opt-in acceptance harness checks the unprivileged user, XDG paths,
`/usr/bin/env`, Nix development loop, Xvfb, Chromium, Git identity, and (when
`ANVIL_ACCEPTANCE_GITHUB=1`) GitHub access:

```sh
ANVIL_SANDBOX_POD=... tests/sandbox-acceptance.sh
```

## Sandbox image layers

The sandbox image is built with `nix2container` and pushed without creating a
Docker archive:

```sh
nix run .#anvil-sandbox-image-push
```

Its content-addressed layers are partitioned into base Unix tools, Nix and
developer tooling, Chromium/Xvfb, OpenCode, and Anvil runtime/config files.
The image starts a root `nix-daemon` and drops the agent process to UID 1000;
the Nix store is intentionally immutable to the agent.

For a local k3s validation image, avoid exporting the full Docker image. The
import helper reuses matching compressed layers already present in containerd
and transfers only new layer blobs:

```sh
just load-sandbox-k3s local-anvil7-<short-sha>
```

The helper creates a short-lived privileged loader pod when
`ANVIL_K3S_LOADER_POD` is not set. It registers the image as
`docker.io/library/anvil-sandbox:<local-tag>` in the k3s `k8s.io` containerd
namespace and verifies the tag before returning.

Warm-cache build and push timings for the five relevant change classes can be
captured with:

```sh
nix run .#benchmark-sandbox-image
ANVIL_IMAGE_BENCHMARK_MODE=push nix run .#benchmark-sandbox-image
```

The output reports no-op, Env/Cmd-only, entrypoint, OpenCode-version, and
Chromium-version timings. The latter two benchmark packages add a marker to
the corresponding input layer so layer invalidation can be measured without
changing production versions.

Example warm-cache build timings from this workspace are:

| Change | Seconds |
| --- | ---: |
| No-op image build | 0.573 |
| Env/Cmd-only change | 5.823 |
| Entrypoint change | 5.885 |
| OpenCode version change | 5.918 |
| Chromium version change | 5.984 |
