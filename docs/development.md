# Development Deployment

## Local-first development and validation ladder

The normal local edit loop runs without Kubernetes, an image build, registry,
or external model credentials:

```sh
nix develop
just dev
```

`just dev-full` adds the optional MCP and router processes. Both use plain
process-compose and Cargo's working-tree debug/incremental artifacts. The
singleton profile and deterministic local model stay up while `watchexec`
restarts only `anvild`; LocalSandboxApi starts real OpenCode workers in durable
directories under `.anvil/dev/sessions`. `ANVIL_LOCAL_RUNTIME_ROOT` and
`ANVIL_LOCAL_PROFILE_DIR` can override those paths. The same commands work in
an Anvil sandbox; local model requests are served by `anvil-test-model` and
never fall through to a hosted provider.

The validation ownership ladder is:

```text
Rust unit/integration
        |
        v
local process E2E                process-compose + LocalSandboxApi
        |
        v
nested actual OCI artifact        nix2container + skopeo + umoci + crun probe
        |
        v
isolated Kind Kubernetes fidelity Agent Sandbox/controller/RBAC/router
        |
        v
production deployment smoke      platform-owned real-cluster rollout
```

Run the explicit tiers with `just e2e`, `just e2e-sandbox-image`, and
`just e2e-k8s`. `just e2e-ui` is the local embedded-frontend/API smoke. The
fast E2E prints total and per-scenario elapsed seconds for cold/warm comparison;
there are no timing gates. The nested OCI test reports whether the current
kernel supports the exact root-to-agent UID mapping; static image checks still
run when that execution mapping is unavailable. The Kind lane owns a temporary
kubeconfig and cluster and is intentionally absent from `just check`, `just
dev`, and `just e2e`.

Ownership boundaries are explicit: process-compose and LocalSandboxApi own
normal development; nested OCI acceptance owns sandbox image/runtime
construction; isolated Kind owns Kubernetes-only fidelity. The production k3s
cluster is not a development harness.

CI's pre-merge lanes run Rust checks, deterministic local E2E, actual sandbox
image acceptance, and isolated Kind fidelity as independent jobs. A Kind pass
in CI or on a developer laptop is still required before merge; this Anvil
sandbox must not run Kind nested.

Kind fidelity starts with an empty Nix PVC, bootstraps the shared daemon, and
starts two sandboxes from the freshly built image. It builds a new derivation in
sandbox A, checks that B sees the exact path after A is suspended and after the
daemon restarts, and enters the dedicated `shared-nix-smoke` environment through
that daemon from B. The full Rust check remains owned by the local-first CI
lane; this smoke verifies the shared Nix development-environment contract
without reseeding its Cargo artifacts. CI enters a minimal `kind-ci` shell for
this lane so the Rust devShell's Cargo artifact hook cannot run before Kind.
On pull requests, the image workflow builds the Anvil, sandbox, baseline
daemon, and upgrade daemon archives once; PR inspection and Kind download and
verify those same archives before consuming them.

## Production deployment

Render without contacting a cluster:

```sh
kubectl kustomize k8s/overlays/dev
```

The development overlay remains in the `anvil` namespace and renders the
portable base with placeholder preview values. The checked-in
`k8s/overlays/kind` overlay uses the **same** `k8s/base` Kustomization
(including the daemon, PVC, and GC) with only Kind image and runtime overrides. It pulls the public `main`
images from GHCR; immutable SHA tags should be selected by an
environment-specific overlay for a controlled deployment. Hostnames, TLS,
Ingress, middleware, storage classes, and platform service URLs belong in that
overlay. The upstream base owns the single shared Nix PVC named
`anvil-nix-shared`; consumers can patch only storage class/capacity, without
creating a second PVC or rewriting the daemon/GC claim references.

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

`anvil-nix-daemon` is the sole writer of the dedicated `anvil-nix-shared` PVC. Its
init container seeds the image's complete runtime store and Nix database on a
fresh PVC and pins the baseline with GC roots; subsequent restarts preserve the
database and builds. New daemon images merge any added runtime store paths and
their Nix database records into an existing volume before starting the daemon;
they do not replace existing builds. `anvild` uses `ANVIL_NIX_PVC` to mount only
`/nix/store` and the Unix daemon socket into sandboxes, both read-only. Agents
are UID 1000 untrusted Nix clients (`NIX_REMOTE=daemon`); `nix develop` and downloads/builds
are reused immediately across sandboxes. The daemon performs builds with its
own `nixbld` users. This is single-node/RWO; multi-node distribution is future
work.

On every daemon container startup, Kubernetes runs `/bin/anvil-nix-deployment-canary`
as a startup probe. It realizes a unique, tiny derivation through the real
shared Nix daemon, including a directory-source copy and chmod. Only after
that succeeds do ordinary socket/database readiness probes take over. The
Docker image smoke test runs the same canary before publication. This avoids
a full project `nix develop` during deployments.

The `anvil-nix-gc` CronJob runs daily at 03:00 UTC on the daemon's node and
uses the daemon protocol against the same PVC. It skips GC at 20% free space
or more; below that threshold it requests enough collection to target 30% free
space. It never removes profiles or roots manually.

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
and Workflows write access (the minimum GitHub App installation-token
permissions needed for ordinary Git pushes and workflow-file changes), while
the new `gh` wrapper requests `gh`, which adds pull-request write access to its
otherwise read-only profile. `gh_read` remains available for older read-only
wrappers. Requests without a purpose use an explicit legacy
profile matching the pre-purpose authority so old Git and `gh` clients continue
to work during rollout. New sandbox images must be rolled out before removing
or changing that compatibility behavior. The GitHub App installation must grant
Workflows: write for the `git` profile and Pull requests: write for the `gh`
profile; GitHub returns HTTP 422 when the corresponding installation permission
has not been approved.
GitHub API failures retain their status, safe message, request ID, and
documentation URL.

The opt-in acceptance harness checks the unprivileged user, XDG paths,
`/usr/bin/env`, Nix development loop, Xvfb, Chromium, Git identity, and (when
`ANVIL_ACCEPTANCE_GITHUB=1`) GitHub access. With
`ANVIL_ACCEPTANCE_GITHUB_PUSH=1`, it also creates an isolated temporary branch,
pushes an ordinary file and a harmless manual-only workflow through the
standard Git credential helper, verifies both on GitHub, then deletes the
remote branch:

```sh
ANVIL_SANDBOX_POD=... tests/sandbox-acceptance.sh
```

## Sandbox image layers

The sandbox image is built with `nix2container` and pushed without creating a
Docker archive:

```sh
nix run .#anvil-sandbox-image-push
nix run .#anvil-nix-daemon-image-push
```

Its content-addressed layers are partitioned into base Unix tools, Nix and
developer tooling, Chromium/Xvfb, OpenCode, and Anvil runtime/config files.
These explicit nix2container layer boundaries are intentional. The sandbox
image contains no usable private Nix database; the dedicated daemon image
includes the same runtime closure. `initializeNixDatabase = true` on the daemon
image seeds its bootstrap database. nix2container
issue [#192](https://github.com/nlewo/nix2container/issues/192) causes nested
Nix builds to fail when `copyToRoot` paths are registered in the embedded Nix
database but are absent from `/nix/store`. Anvil temporarily pins the fix from
[PR #199](https://github.com/nlewo/nix2container/pull/199) until it lands in
the normal upstream revision; replace the fork pin with that upstream revision
after the fix is released. The sandbox image keeps the Nix CLI but starts no
daemon; its bootstrap drops the agent process to UID 1000.
Repository-owned image files are passed to the sandbox Nix module as explicit
path dependencies. Chromium's packaged command wrapper runs the browser with
`--no-sandbox`; browser isolation is provided by the surrounding Agent Sandbox
container boundary, without granting the workload broad kernel capabilities.

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