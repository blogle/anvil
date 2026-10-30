# ExecPlan: autonomous first slice

**Status:** ACTIVE DEVELOPMENT · **Target:** `v2` · **Branch:** `anvil/anvil-first-slice-completion-58824672` · **Draft PR:** [#124](https://github.com/blogle/anvil/pull/124)

This is the single authoritative campaign record: approved FS-01–FS-15 criteria,
evidence ledger, findings, parity inventory, successor work and deployment gate.
Maintain it under [repository-root PLANS.md](https://github.com/blogle/anvil/blob/anvil/anvil-first-slice-completion-58824672/PLANS.md). Permanent domain semantics live in
[specification](../../spec.md), [architecture](../../architecture.md) and
[operations](../../operations.md). No criterion is amended by this migration.

## Current checkpoint and navigation

- [Approved objective, constraints and obligations](#approved-contract)
- [Concrete progress and exact historical results](#evidence-ledger)
- [Incumbent parity inventory](#incumbent-parity)
- [Remaining work and successor handoff](#successor-handoff)
- [Deployment execution gate](#k8s_acceptance_request-not_executable)
- [Prepared live acceptance sequence and evidence](#live-acceptance)
- [Migration decisions, verification and outcome](#migration-checkpoint)
- [Governed Assignment steering checkpoint](#governed-assignment-steering)

No complete FS-01–FS-14 obligation is VERIFIED. **FS-15: BLOCKED_EXTERNAL**;
**K8S_ACCEPTANCE_REQUEST: NOT_EXECUTABLE**. The `sandboxImageGate` still fails;
the untrusted Nix `derivation add` and preflight protocol-authorization findings
remain open. No deployment, dotfiles work, merge, release or cutover is authorized.
Historical checkpoint counts, findings and limitations below retain their original
scope and chronology; later evidence does not retroactively rewrite earlier results.
In particular, the parity matrix contains stale rows (including Git/CI/provider
handoff assessments); refreshing and independently comparing them remains work.
Latest engineering progress is the [governed Assignment steering checkpoint](#governed-assignment-steering).
Its local steering path supersedes the earlier missing-steering residual for this
bounded interface; historical evidence and wider API/UI parity gaps remain.

<a id="evidence-ledger"></a>
## Evidence ledger

This ledger follows immutable requirements in [the approved contract](#approved-contract), together with [domain semantics](../../spec.md) and [architecture](../../architecture.md). A local check proves only the behavior it measures. Permitted statuses are `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, `BLOCKED_EXTERNAL`, and `FAILED`. A status of `VERIFIED` requires the complete obligation's evidence, not merely implementation or a green broad test suite.

Contract synchronized from PR branch commit `7dea044425d94db3e694c8a6e1eca0a78a7f4076`; the configured-daemon real-push checkpoint below is the latest implementation checkpoint. Incumbent source baseline inspected read-only at `origin/main` SHA `b55f9b0ecbf89309832c6dcdc9a615cbc4e15f8b`.

| ID | Status | Evidence, executed tests, and remaining gap |
|---|---|---|
| FS-01 | IMPLEMENTED_UNVERIFIED | Bun/Nix/SDLC config in `flake.nix`, `nix/bun.nix`, `bun.lock`, generated `bun.nix`, `package.json`, `justfile`; bun.lock sole JS lock; pinned `gitMinimal` is in the Nix check/dev shell for the local Git credential-process test. No tracked Cargo/Rust/npm lock/image files. `scripts/check-bun-lock-drift.sh` runs in `just check`; generated lock match and deliberate drift detection passed. This attempt adds `.changes/worker-git-credentials.json` (existing fragment retained). External release-policy review remains. |
| FS-02 | IMPLEMENTED_UNVERIFIED | Pure domain in `src/domain.ts`; frozen-input test and no-op decisions in `test/domain-core.test.ts`; SQL trigger test `test/lifecycle.test.ts` proves identical Wait, Hold, and Escalate polling execute zero Commission UPDATEs; forged transition denied in `test/store.test.ts`; roots `src/` and `test/`. Current suite: 94 tests. Remaining: exhaustive decision coverage and independent source review. |
| FS-03 | IMPLEMENTED_UNVERIFIED | `src/domain.ts` compares approved amendments by semantic obligation ID/content/policy and treats identical (including reordered) amendments as no-ops. `test/domain-core.test.ts` “an identical amendment is a no-op and a stale generation is rejected”; `test/store.test.ts` “application authorization port rejects objective/criterion replacement…” and “application rejects a stale approved amendment…”; `test/lifecycle.test.ts` terminal amendment in “one unattended lifecycle converges…” remains rejected. Current `just check` passed 81 tests. Remaining: authority freshness beyond the exact generation-CAS and wrong-principal cases. |
| FS-04 | IMPLEMENTED_UNVERIFIED | SQLite schema v3 adds criterion provenance and v4 adds durable `interrupt` Operations; SQL Operation journal persists `submitted` before provider dispatch in `src/application.ts`. `test/lifecycle.test.ts`: prepared/submitted/ambiguous/retry restart cases. `test/store.test.ts`: retry identity persistence. Watchdog interrupt lost-ack recovery is exercised in the configured daemon process. New delivery process case creates a PR remotely, returns HTTP 504 after effect, then reobserves by worker branch; it proves one PR create and a durable accepted integrate Operation across actual SQLite/daemon work. Remaining: process-kill failpoints between every SQLite/provider boundary and randomized crash matrix. |
| FS-05 | IMPLEMENTED_UNVERIFIED | Owner/epoch checks and predecessor resolution in `src/domain.ts`; `test/store.test.ts` “a successor Lease holder resolves a predecessor Operation…”; `test/lifecycle.test.ts` “a successor ApplicationService observes a predecessor's accepted turn after lost acknowledgement” closes/reopens SQLite before B takes over and inspects, then proves stale A cannot reconcile or dispatch and the original dispatch count remains one. Competing SQLite connection CAS is tested by “two SQLite controller connections cannot both mutate one Commission version”. Remaining: Workspace single-writer/independent verifier snapshot and actual Kubernetes Lease adapter. |
| FS-06 | IMPLEMENTED_UNVERIFIED | `test/domain-core.test.ts`: “maxAttempts one admits its first Attempt but blocks a second strategy Attempt”; “over-limit instructions, cost, and deadline hold without preparing effects”; “attempt and repair overlimits block only another strategy or repair”; “recording measured usage may cross the cost limit but blocks the next instruction”; “budget exhaustion blocks new work but not recording authoritative delivery”. `test/store.test.ts` “cost overrun is retained across SQLite reopen and blocks new provider work” proves measured overrun is durable and no new operation dispatches after restart. The configured daemon watchdog test also caps a stuck active Assignment at `maxAttempts=1` and holds rather than starting a second Attempt. Existing no-op lifecycle tests prove unchanged Wait/Hold polling does not increment version or execute SQL UPDATEs. Remaining: randomized bounded nonproductive-loop/restart traces and explicit deadline persistence combined with takeover. |
| FS-07 | IMPLEMENTED_UNVERIFIED | `Evidence.criterionVersion` retains specification/Candidate/provenance binding. `ProviderComposition` accepts only completed assistant lines `ANVIL_EVIDENCE <obligation-id> <candidate-sha>: <claim>` whose SHA matches the observed Candidate, as submitted worker claims attributed to OpenCode Session; never independent acceptance. Required CI comes from target branch rules/classic protection and exact-SHA Check Runs/commit statuses; absent policy is unknown, missing contexts missing, and skipped/neutral/incomplete never passing. The configured-process trace supplies an old-SHA claim on the changed Candidate; the daemon continues instead of accepting the stale report. Required checks are adversarially tested in `test/providers/github-world.test.ts` and `test/domain-core.test.ts`. Independent evidence/freshness matrices and live ruleset validation remain. |
| FS-08 | IN_PROGRESS | `src/providers/opencode.ts` extracts visible assistant text; `src/providers/composition.ts` accepts only explicit obligation claims that state the exact currently observed Candidate SHA. Continue/Repair directives specify that contract; worker claims remain non-independent. The configured daemon test autonomously drives Continue→failing required check→Repair→stale worker-claim rejection→Continue→stale-check Wait→pending-check Wait→Integrate→queue wait→Conclude across restart. Its delivery worker fixture now creates commits and publishes them through the real Git credential helper into a local bare HTTP receiver; the GitHub branch adapter reads that receiver ref with `git rev-parse`. Remaining: actual Sandbox helper/capability bootstrap, pinned deployed OpenCode compatibility, randomized SSE loss/order/restart and broader tool-boundary/context traces. |
| FS-09 | IMPLEMENTED_UNVERIFIED | `test/daemon-configured-process.test.ts` “configured Bun daemon composes local HTTP providers and recovers bindings without replay” exercises actual Bun child + SQLite + Sandbox/OpenCode/GitHub/Mergify HTTP services. After persisted Workspace and Session Operations, its fixture writes an Assignment-scoped capability with mode 0600. A missing capability causes `git push` to fail; the bare ref remains absent and GitHub branch GET returns 404. The worker then creates and pushes actual Git commits via `src/providers/git-credentials.ts`; GitHub branch GET derives the observed SHA from bare-repository `git rev-parse`. The daemon drives failing required CI→Repair→stale worker claim rejection→new pushed Candidate→stale-check Wait→pending-check Wait→restart→pass→PR #52→queue Wait→foreign PR Escalate→wrong-head non-conclusion→Conclude. The first PR create loses its ack; remote re-observation records one create. Assertions include three delivery prompts, two Continue, one Repair, one Integrate and one PR create. Git commits/pushes and branch observation are now real local process/HTTP fixture effects; Sandbox/OpenCode provisioning, CI/check results, PR creation/observation, Mergify queue/merge remain local fixtures. Local Lease expiry cannot be advanced via the daemon test port; randomized/multiprocess crash ordering remains. |
| FS-10 | IN_PROGRESS | `src/providers/git-credentials.ts` reuses the GitHubAppBroker `contents:write` profile, signs Commission/Assignment/Attempt/Session/Workspace/repo/ref/controller-epoch/expiry claims, provides `/v1/git/credentials` and the Bun helper. `ApplicationService.authorizeWorkerGitCapability` checks active Commission/Attempt, exact Assignment and persisted provision/Session Operations, canonical repository/ref, owner epoch and live unexpired Lease on every issuance. `test/providers/git-credentials.test.ts` launches actual `git credential fill` and `git push` from a separate Git process through Hono and local GitHub App/Git HTTP fixtures; the resulting commit SHA is verified in a real bare repo via `git rev-parse`, and wrong/multi-ref pushes are rejected by the fixture's pre-receive branch rule. It also denies other repository/Commission/Assignment/Attempt/Session/Workspace/controller epoch/ref, stale/expired Lease, expired capability, held/concluded Commission, and unauthorized `gh` purpose; tests token refresh, service+SQLite restart, 0600 capability file, and secret redaction. Local ref enforcement here is receiver branch-policy fixture evidence, not a controller proxy. Limit: Git credential fill returns an extractable repository-wide token until provider expiry. Missing: actual Sandbox capability/helper bootstrap and live provider validation. |
| FS-11 | IN_PROGRESS | Bun daemon `src/main.ts`; authenticated Hono HTTP/Streamable MCP `src/daemon.ts`; SQLite migrations/scheduler and configured provider factory. Schema v5 durable operational projection and paginated decision/error history are shared by HTTP and MCP (`test/operational.test.ts`); evidence/attempt/pending Operation details are included. `/v1/git/credentials` uses Assignment capability authentication and ApplicationService authorization. Configured process trace covers delivery through Conclude. Remaining: Campaign graph/commands, full Assignment/Findings/steering surface, command audit, complete auth parity, real Sandbox capability bootstrap and deployment hardening. MCP sessions are volatile across restart. |
| FS-12 | IN_PROGRESS | Actual React/Vite/TanStack Router+Query/Tailwind Ledger UI in `web/`; Nix `ui` artifact served by the packaged daemon. `test/ui.test.tsx` exercises authenticated data, hold/resume/amend and stale-generation rejection against real Hono/ApplicationService/SQLite; package smoke fetches actual compiled assets. Inbox filters and Commission decision/evidence/Operation/Finding-reference/history/Attempt views exist. Remaining: Campaign specification/graph, richer Findings/review/diff flows, serialized steering, external OpenCode/preview links, complete visual/accessibility/browser/screenshot review. This is operational partial implementation, not FS-12 acceptance. |
| FS-13 | IN_PROGRESS | Implementation commit `cb65ebf` exposes `packages.x86_64-linux.daemon`; OpenCode runtime commit `2a18c16` (smoke corrections `4ac7fe4`, `1d8174a`) pins OpenCode 2.0.32. Sandbox image commit `6171c8c`, image guard `286535d`, isolated-store proof `3a4d3a3`, ordered preflight `1c6982c`, NAR comparison, temporary Unix-daemon/signature proof, and main-container socket isolation add a pinned nix2container worker image and NAR-checking preflight. Signed closure import/preflight pass locally; arbitrary untrusted `derivation add` remains BLOCKED, and preflight socket operations are not protocol-read-only. Sandbox overlay compatibility remains BLOCKED/INCOMPATIBLE and `sandboxImageGate` intentionally fails. No Sandbox seeding or runtime acceptance is claimed. |
| FS-14 | IMPLEMENTED_UNVERIFIED | Read-only incumbent source inventory at `origin/main` SHA above. [Incumbent parity inventory](#incumbent-parity) records feature-by-feature source references, local rewrite state/gaps, and explicit cutover prohibition. Remaining runnable comparative scenarios and independent review; no evidence supports cutover. |
| FS-15 | BLOCKED_EXTERNAL | Required separate authorized dotfiles deployment and isolated live namespace execution cannot be performed by this worker. No cluster/dotfiles actions taken. [Preparatory live acceptance sequence](#live-acceptance) is not approval or acceptance evidence. Only independently authorized execution/review can move this status. |

## G01–G06 adversarial findings

| Finding | Test evidence | Status |
|---|---|---|
| G01 / FS-05 predecessor operation recovery | `test/store.test.ts` successor resolution plus `test/lifecycle.test.ts` “a successor ApplicationService observes a predecessor's accepted turn after lost acknowledgement”; stale predecessor rejected and fake remote dispatch count remains one. | Application-level deterministic case passed; Workspace/Kubernetes lease gates remain. |
| G02 / FS-04 retry recovery | `test/store.test.ts` “retry_authorized survives restart…” now injects remote acceptance/lost acknowledgement during replay, reopens again, inspects and resolves the original ID without another dispatch. | Local failure/reopen case passed; earlier crash-matrix phases remain. |
| G03 / FS-07 registered delivery identity | `test/domain-core.test.ts` matching registered identity vs foreign PR/repository/target, mismatched SHA, stale/future/open/queued/check/review observations. | Local adversarial cases passed; full evidence invalidation matrix remains. |
| G04 / FS-06 active first Attempt | `test/domain-core.test.ts` “maxAttempts one admits its first Attempt but blocks a second strategy Attempt”. | Passed. |
| G05 / FS-03 concluded specification immutability | `test/lifecycle.test.ts` terminal amendment rejection; objective retained. | Passed. |
| G06 / FS-02 stable no-op | `test/domain-core.test.ts`, `test/lifecycle.test.ts` repeated Wait/Hold/Escalate and SQL UPDATE trigger. | Passed locally. |

## Earlier complete verification (Git helper/push code commit `99d0980`)

- `nix develop -c just fmt` — passed; no formatting changes remained.
- `nix develop -c just check` — passed: lock match and deliberate drift-negative probe, formatting, strict TypeScript, 94 tests / 1121 assertions locally.
- `nix develop -c just ci-check` — passed; Nix flake and TypeScript checks passed.
- `nix develop -c just ci-verify` — passed.
- `nix run .#sdlc -- install --check` — passed, including `.changes/worker-git-credentials.json`.
- Clean clone at exact code commit `99d0980`: all four prescribed commands passed; 94 tests / 1130 assertions.
- GitHub checks at PR head `45f7f2d`: SDLC `check`, `check/flake`, `check/gate`, `pr-fast`, `evaluate`, `policy`, and Mergify Summary passed; release `gate`, SDLC `verify`, and Mergify queue/protections were skipped.

## Configured-daemon real-push checkpoint

- `nix develop -c bun test test/daemon-configured-process.test.ts` — passed: 1 test / 195 assertions.
- `nix develop -c just check` — passed: formatting, strict TypeScript, and 94 tests / 1135 assertions.
- The configured-process fixture waits for observed Sandbox and Session Operations before writing its short-lived Assignment-bound capability file at mode 0600. A worker Git push with the capability path absent fails; no bare ref is present and the GitHub branch GET returns 404. The helper-authenticated push then creates the first observed Candidate in the local `git-http-backend` bare repository. Branch GET obtains the exact ref SHA using `git rev-parse`.
- This checkpoint proves a local worker Git subprocess, helper credential service, real Git commit/push, and daemon branch observation together. Sandbox capability/helper installation, and CI, PR, Mergify queue and merge observations are still fixture-driven; no live provider or deployment acceptance is claimed.

## FS-13 daemon package checkpoint (implementation commit `cb65ebf`)

- `nix build .#daemon -L` — passed; package is `anvil-daemon-0.1.0`, built with repository `nix/bun.nix` and `bun2nix.fetchBunDeps` from the existing `bun.nix`. No second dependency lock or imperative network install was added.
- `nix path-info -r .#daemon` — inspected runtime closure: the daemon output plus Bun 1.2.5, Bash 5.3 and its glibc/runtime dependencies. Package contents include `bin/anvil-daemon`, `lib/anvil/src/main.ts`, all `src` runtime modules and SQL migrations, `package.json`, and pinned `node_modules`.
- `nix build .#checks.x86_64-linux.daemonSmoke -L` — passed. The Nix check launches the built executable as a non-root user from an isolated temporary working directory with `ANVIL_PROVIDER_MODE=unavailable`, a test-only API token, temporary `ANVIL_DATABASE`, and an ephemeral `PORT`. It checks `/healthz`, `/readyz`, migration version 4, authenticated Commission persistence, clean SIGTERM, and restart/reopen with the same Commission row and schema.
- Runtime interface exercised: executable inherits its caller's UID and current working directory; package code is in the read-only Nix store. `ANVIL_DATABASE` must point into a writable directory (default is `./anvil.sqlite` relative to the caller's working directory); `ANVIL_API_TOKEN` is required and at least 32 characters; `PORT` defaults to 8080; `/healthz` and `/readyz` are GET probes. The non-root smoke writes state only to its temporary directory, so a later read-only-rootfs container needs a writable state mount and externally supplied credentials/configuration.
- `nix develop -c just check` — passed: 94 tests / 1137 assertions, including strict typecheck and script formatting. `nix develop -c just ci-check` — passed; `nix run .#sdlc -- install --check` — passed; `nix develop -c just ci-verify` — passed. These are local checks, not container or deployment acceptance.
- FS-13 remains IN_PROGRESS: there is no OCI/nix2container artifact, UI package, Sandbox image, tested read-only-rootfs deployment, compatible Sandbox/shared-Nix interface validation, or live acceptance. This package establishes only the daemon runtime contract.

## FS-13 pinned OpenCode runtime checkpoint (implementation `2a18c16`, smoke corrections `4ac7fe4` and `1d8174a`)

- `nix build .#opencodeRuntime -L` — passed; `packages.x86_64-linux.opencodeRuntime` reuses `pkgs.opencode` from the existing locked Nixpkgs input, revision `02c087f3fe673c9e317f206a627cb6b910336dbe`, version `2.0.32`. The built output inspected at `/nix/store/9ysv2ynpka84idp745mcd8l0ayc2f102-opencode-2.0.32` contains `bin/opencode` and package share assets. `nix path-info -r .#opencodeRuntime` shows the executable's runtime closure, including glibc/libgcc, ripgrep/pcre2, libffi, and Wayland libraries.
- `nix build .#checks.x86_64-linux.opencodeSmoke -L` — passed using the actual `opencode serve` executable, not an HTTP stub. `scripts/smoke-opencode-runtime.ts` runs non-root with temporary HOME/XDG/TMPDIR, a generated ephemeral local HTTP password, and a loopback ephemeral port. Through `OpenCodeAdapter` it verifies exact `/api/info` version `2.0.32`, session creation, session existence, message response shape, active-session response shape and idle execution observation. It submits no model instruction and requires no provider credential. The negative case confirms a distinct closed route returns `unavailable`; SIGTERM exits with the runtime's observed status 130 and the API becomes unreachable.
- Runtime assumptions: the OpenCode process inherits the non-root UID; its HOME, XDG config/cache/data/state, and TMPDIR paths must be writable. The test binds to loopback on a dynamically reserved port and restricts PATH to the pinned package's `bin` directory. Startup probes retry transient HTTP readiness responses for a bounded interval; an unsupported API version fails immediately. The per-run HTTP password is generated in memory and neither printed nor persisted; subprocess stdout is discarded and stderr is captured with that value redacted. Active-turn `/api/model`, SSE `/api/event`, actual model-provider auth and workspace tool execution are not part of this no-instruction smoke.
- Image/mount constraint remains unresolved: future Sandbox `podTemplate` mounts `/nix/store` from the shared Nix service, which may cover store paths baked into an image. Image layering and shared-store mount compatibility must be validated before an OCI/Sandbox image is claimed. FS-10 live Sandbox compatibility remains unverified; FS-13 stays IN_PROGRESS, with no OCI image or Sandbox layout introduced here.
## FS-13 Sandbox worker OCI image checkpoint (implementation `6171c8c`, image guard `286535d`)

- `nix build .#sandboxWorkerImage -L` — passed. `packages.x86_64-linux.sandboxWorkerImage` is a nix2container image named `anvil-sandbox-worker:opencode-2.0.32`. nix2container is pinned in `flake.lock` at `nlewo/nix2container` revision `42d1df94f001a9416ef08be7b305144074aca9d2`, with Nixpkgs following the existing locked `sdlc/nixpkgs-latest`. The Nix manifest is `/nix/store/vhzf2kbcfrx00v4ly3lqixcyi7zyks4w-image-anvil-sandbox-worker.json`.
- The built OCI config/layers were inspected. Config uses UID/GID `1000:1000`, workspace `/home/anvil/workspace`, `4096/tcp`, `OPENCODE_PORT=4096` (entrypoint accepts configurable ports 1024–65535), HOME/XDG/TMPDIR paths, and an OpenCode v2.0.32 server entrypoint. Four explicit layers cover Git/shell tools, OpenCode closure, entrypoint, and rootfs writable paths/identity. Rootfs includes the non-root `anvil` passwd/group entry; nix2container permissions set `/home/anvil` and workspace to 0777 and `/tmp` to 1777. Runtime closure is under `/nix/store` and includes OpenCode, Git, Bash/coreutils/search/edit tools and their libraries.
- `nix run .#sandboxWorkerImage.copyTo -- oci:/tmp/anvil-sandbox-worker-oci-init-preflight:opencode-2.0.32` — passed without a container runtime. OCI layout `index.json`, manifest and config were inspected; manifest digest is `sha256:7041a2eb72f66b714fe39cb57bcd43bf4156b1a7b2575cdf2b1308dec3bdab35` with five layers, including the preflight layer. Local container execution was not run: `for tool in podman docker buildah containerd nerdctl ctr runc; do command -v "$tool" || true; done` found no runtime binaries. No Kubernetes or deployed runtime behavior is inferred from the archive.
- `nix build .#checks.x86_64-linux.sandboxImageGate -L` — **fails closed as intended** after the positive image-content assertion: it prints both `PASS IMAGE-CONTENT` and `BLOCKED/INCOMPATIBLE`. The automated check reads `buildSandboxResource`'s actual Pod spec, confirms the read-only `shared-nix` PVC `subPath: store` mount over `/nix/store` and absence of an init-container shared-store closure population contract, and simulates an adversarial empty-volume overlay that hides the baked OpenCode path. `nix develop -c just ci-check` likewise fails on this known compatibility gate; it must not be reported as green.
- `nix develop -c just check` — passed: 94 tests / 1099 assertions. `nix develop -c just ci-verify` and `nix run .#sdlc -- install --check` — passed. The local check status is distinct from the BLOCKED image/volume compatibility result.
- Compatibility remains **BLOCKED/INCOMPATIBLE** until one runtime interface is approved: either guarantee/prefetch the complete image closure into the shared Nix PVC before container start, or change the `/nix/store` mount design so it does not obscure the image closure. No strategy is selected here, and `buildSandboxResource`, manifests and deployment configuration are unchanged. FS-10 live Sandbox helper/capability compatibility remains unverified; FS-13 remains IN_PROGRESS.

## FS-13 isolated shared-store closure seed proof (implementation commit `3a4d3a3`)

- `nix run .#sandboxWorkerStoreSeed` — passed with locked Nix CLI 2.34.9. The Nix-packaged proof derives the complete closure from `sandboxWorkerImage` via `pkgs.closureInfo`, creates a fresh `local?root=<temporary-directory>` store, confirms OpenCode 2.0.32 is initially absent, then runs `nix copy --offline --no-check-sigs` from the existing host store into that isolated store. The destination is only the temporary store; the host `/nix/store` is never a copy target.
- After seeding, destination `nix path-info --recursive` exactly matches all 47 paths in the image closure, including OpenCode, Git, entrypoint/interpreter, tool links, CA certificates and transitive libraries. `nix store verify --no-trust --recursive` validates their registered contents. The isolated store is made writable for cleanup and removed at test exit. This is a real Nix store/registration proof, not an OCI-JSON marker simulation.
- The empty-store negative assertion rejects readiness before seeding because the OpenCode path is absent. The prior `sandboxImageGate` still fails BLOCKED/INCOMPATIBLE; this proof establishes that closure export/import works locally but does not establish persistent shared-PVC access, pre-provisioning ordering, Pod start behavior or closure seeding by the Sandbox controller.
- Next interface decision remains: specify how this exact complete closure seed runs before the existing Pod mounts the shared store, or revise the mount contract. Do not treat local isolated-store import as live Sandbox acceptance. FS-13 and FS-10 remain IN_PROGRESS.

## FS-13 ordered Sandbox store preflight checkpoint (implementation commit `1c6982c`)

- `src/providers/agent-sandbox.ts` now places `verify-worker-store-closure` before the preserved `initialize-workspace` init container. It uses the same immutable image as the main container, mounts the shared PVC store at `/run/anvil/shared-nix/store` (not over the baked `/nix/store`) plus the existing Nix daemon socket, and runs as the image's UID 1000. The main container remains non-root and retains the existing `/nix/store` overlay. `test/providers/agent-sandbox.test.ts` asserts init ordering, exact command/args, both shared-volume mounts, and the absence of a preflight `/nix/store` overlay.
- The pinned image carries `/etc/anvil/worker-image-closure.paths` and a preflight executable whose embedded SHA-256 pins that manifest. It queries the daemon store URI for every manifest path with `nix path-info`, runs `nix store verify --no-trust`, and compares each read-only mounted path's SHA-256 NAR hash to the daemon's registered `narHash`. Missing/unregistered paths, invalid daemon content, mounted bytes that differ from the daemon store, unavailable store/socket, or an altered manifest cause a nonzero init exit before the main container can start. The preflight uses the shared daemon URI in the Pod spec.
- The current `nix run .#sandboxWorkerStoreSeed` proof executes that same image preflight executable with locked Nix CLI 2.34.9 against two distinct isolated stores: registered daemon store A and mounted-store directory B. It rejects an unseeded daemon store and altered manifest; after seeding/verifying A it rejects an empty B and a B containing same-name but tampered OpenCode bytes, then accepts B only when all 91 runtime-manifest paths have matching NAR bytes. The image closure has 95 paths. This uses real Nix registration/content/NAR checks, not path-existence markers; temporary stores are removed and `/nix/store` is never a destination.
- The original direct-store proof exercises `local?root=`; the Unix-socket proof below separately tests a real local Nix daemon and read-only mount permissions. Neither test reaches the Sandbox's mounted socket/PVC, verifies backing contents or seed-before-Pod ordering, or starts a Pod. The fail-closed `sandboxImageGate` remains blocked until a pre-seed contract guarantees the closure; no credential bootstrap or controller seeding job was added. FS-10 live Sandbox helper/capability compatibility remains unverified.
- `nix develop -c just check` — passed: formatting, typecheck, 94 tests / 1123 assertions. `nix build .#sandboxWorkerImage`, `nix develop -c just ci-verify`, and `nix run .#sdlc -- install --check` — passed. `nix develop -c just ci-check` — fails at the retained `sandboxImageGate`, which prints the positive image-content result and then `BLOCKED/INCOMPATIBLE` because the current pod still has no closure pre-seeding guarantee and overlays the image store.
- The follow-on `nix run .#sandboxWorkerStoreSeed` proof now starts pinned Nix 2.34.9 `nix daemon` as UID/GID 1000, sets `NIX_DAEMON_SOCKET_PATH` to a fresh temporary socket, and configures only that daemon's backend as `local?root=<temporary>&require-sigs=false`. Nix 2.34.9 `nix daemon --help` has no `--socket-path`; the documented `unix://<socket>` store URI successfully targets the temporary listener. The store-info handshake reports `Trusted: 0`; no force-trusted mode is used. `nix copy --from daemon --to unix://<temporary-socket>` uses the host daemon only as the source; the test's copy destination is the temporary backend, and the system daemon is not mutated.
- That proof runs the actual packaged preflight over `unix://...`: a seeded temporary daemon plus matching read-only mounted closure passes for all 91 runtime paths; a healthy daemon rejects an empty mount and a same-name tampered OpenCode path; missing and stopped-daemon socket URIs fail closed. The proof asserts UID 1000 and that this client cannot create a file in the mounted directory. The daemon runs as the same unprivileged UID and is stopped with a bounded SIGTERM/SIGKILL cleanup before its temporary backend is removed.
- Scope remains local Nix protocol/permissions evidence only. It does not validate Kubernetes socket mounts, PVC bytes, daemon identity/configuration in Sandbox, or any pre-seed operation/order. No PVC seeding operation, controller ordering beyond the init-container sequence, credential bootstrap, or deployment evidence was added. The fail-closed `sandboxImageGate` remains blocked pending the separate closure pre-seeding contract; FS-13 and FS-10 remain IN_PROGRESS.
- `nix develop -c just check` — passed: formatting, typecheck, 94 tests / 1143 assertions. `nix develop -c just ci-verify` and `nix run .#sdlc -- install --check` — passed. `nix develop -c just ci-check` — fails at the retained `sandboxImageGate`, which prints `PASS IMAGE-CONTENT` then `BLOCKED/INCOMPATIBLE`; it must not be reported as green.

## FS-13 signature-enforced worker-store import attempt

- `nix run .#sandboxWorkerStoreSignatures` uses Nix 2.34.9 to copy the 91 manifest paths from the existing host daemon into a `local?root=<temporary>` source store, then runs the proof against a separate temporary Unix-socket daemon. The host daemon is source-only; the import target is always the temporary backend. No system daemon configuration changes or host store path is a test destination.
- The proof creates a fresh ephemeral Ed25519 key pair at runtime. The private keys stay in the mode-0600 temporary directory and are deleted at exit; only one generated public key is configured on the target. The target backend uses `require-sigs=true`, the client is UID/GID 1000 with Nix `Trusted: 0`, and network substituters are disabled. The isolated source metadata confirms `anvil-sandbox-worker-writable-paths` has an empty signature list. Copying that unsigned closure, and copying after signing with only the wrong ephemeral key, both fail at the target with `lacks a signature by a trusted key`; neither target `nix copy` passes `--no-check-sigs`. After signing the source closure with the one trusted key, the untrusted client imports all 91 paths without that flag. `path-info`, signature-aware `store verify`, and the actual packaged preflight over the socket/read-only mounted bytes pass.
- **Unresolved security negative:** an input-addressed test derivation is created in the temporary source store, serialized with `nix derivation show`, then submitted by the same untrusted client using `nix --store unix://<temporary-socket> derivation add`. On Nix 2.34.9 this command exits 0 even though the daemon is `require-sigs=true` and reports `Trusted: 0`; `path-info` also exits 0 for `/nix/store/fyw34ama5lc2s00scyc24wmb900qa4r3-anvil-unsigned-import-probe.drv`. `nix store verify` then exits 4 with `path '/nix/store/fyw34ama5lc2s00scyc24wmb900qa4r3-anvil-unsigned-import-probe.drv/' does not exist`. The proof emits `BLOCKED/INCOMPATIBLE` and exits nonzero at this case. Therefore the signed `nix copy` path is demonstrated, but this checkpoint does **not** establish that the daemon prevents untrusted clients from submitting/registering arbitrary derivations. No permission-bypassing workaround or deployment implication is claimed.
- Exact Nix CLI contract inspection: `nix develop -c nix key generate-secret --help`, `nix develop -c nix key convert-secret-to-public --help`, `nix develop -c nix store sign --help`, `nix develop -c nix derivation add --help`, and `nix develop -c nix store verify --help`. The proof's failed derivation-add assertion records actual Nix behavior rather than treating `require-sigs=true` as covering that operation.
- `nix run .#sandboxWorkerStoreSignatures` reports the signed-copy and preflight positives, then exits nonzero at the derivation-add blocker. `nix develop -c just check` — passed: formatting, typecheck, 94 tests / 1142 assertions. `nix develop -c just ci-verify` and `nix run .#sdlc -- install --check` — passed. `nix develop -c just ci-check` — still fails at the unchanged `sandboxImageGate` with `BLOCKED/INCOMPATIBLE`; FS-13 and FS-10 remain IN_PROGRESS.
- Local scope only: no Kubernetes/socket mount/PVC validation, pre-seeding operation/order, system daemon configuration changes, provider mutation, deployment, or dotfiles actions. The host daemon serves only as the read-only source; test copy destinations are temporary stores. The incomplete derivation-add boundary plus the separate shared-store pre-seed contract prevent any production compatibility or acceptance claim.

## FS-13 OpenCode main-container Nix socket isolation

- `buildSandboxResource` in `src/providers/agent-sandbox.ts` now includes the shared daemon socket only in `verify-worker-store-closure`, still ordered before `initialize-workspace`. The OpenCode `sandbox` container retains the shared PVC `/nix/store` overlay at `subPath: store` and workspace/profile mounts, but no shared-Nix daemon socket mount.
- `assertOpenCodeCannotMountSharedNixDaemonSocket` is run when generating the PodTemplate. It identifies all volume names backed by the configured shared-Nix PVC and fails closed if any main-container mount uses the socket file/directory or an ancestor `subPath`, an unresolved `subPathExpr`, or an invalid path. `test/providers/agent-sandbox.test.ts` asserts the actual generated init ordering/socket mount and main mount list, then mutates the fixture with both a direct socket mount and an aliased shared-PVC parent mount; the guard rejects both unsafe variants.
- `nix develop -c bun test test/providers/agent-sandbox.test.ts` — passed: 6 tests / 63 assertions. `nix build .#sandboxWorkerImage --no-link` — passed. `nix develop -c just check` — passed: 95 tests / 1149 assertions. `nix develop -c just ci-verify` and `nix run .#sdlc -- install --check` — passed. `nix develop -c just ci-check` — remains red at the retained `sandboxImageGate` with `BLOCKED/INCOMPATIBLE`.
- Residual security gap: the init preflight still needs access to a real Nix daemon Unix socket. A volumeMount marked `readOnly` does **not** make Nix protocol operations read-only; the signature proof at this head demonstrated `nix derivation add` can succeed for a `Trusted: 0` client with target `require-sigs=true`, although the resulting `.drv` failed NAR verification. This change isolates the OpenCode main container only; it does not prove preflight socket authorization, secure seeding, PVC/socket behavior, or any deployment compatibility. FS-13 and FS-10 remain IN_PROGRESS, and the arbitrary-derivation negative remains failed/BLOCKED.

## New finding F-NEW-01 — fail-closed required CI evidence

- Reproduced false green before the fix: focused `test/providers/github-world.test.ts` reported a completed `skipped` run as `state: passing`; unrelated current-SHA and foreign-SHA runs could not distinguish the declared required context because no required profile was read. The first post-regression run failed four newly added cases (skipped/neutral, missing context, no policy, and queue/source-CI separation) against the previous behavior.
- Fixed in `src/providers/github-delivery.ts` and `src/providers/github-world.ts`: resolve effective branch rules plus classic protection contexts on the Commission's integration target; match app/context identity and exact Candidate SHA; read combined commit statuses for legacy contexts. Only `success` counts as passing. Missing is `missing`; pending is `pending`; failures are `failing`; skipped/neutral, incomplete results, and an empty policy are `unknown`; transport/auth failure propagates as unavailable/rejected. Mergify queue state is separate.
- Domain guard in `src/domain.ts` returns `Wait` for missing required evidence; `test/domain-core.test.ts` “a missing required check blocks integration despite otherwise green Candidate evidence” proves no integration Operation is prepared.
- Broker boundary in `src/providers/github-app.ts`: removed `workflows:write` from Git-purpose token; GitHub read profile adds only `administration:read` and `statuses:read` for branch rules and commit-status reads. Tests assert per-repository contents-only write token scope and mismatch rejection.
- Current bounded test command: `nix develop -c bun test test/providers/github-world.test.ts test/providers/github-app.test.ts test/providers/github-delivery.test.ts test/providers/composition.test.ts test/domain-core.test.ts` — passed 40 tests / 551 assertions; full and clean-clone results are recorded above.
- Still open: no actual Assignment-bound credential bootstrap into OpenCode/Sandbox is deployed; do not expose Git token to prompt/env/config. The configured-daemon local trace now uses real helper-authenticated Git commit/push, but provider and Sandbox behavior remain fixture-based. This fix does not make FS-07 or FS-10 VERIFIED.

## New finding F-NEW-02 — configured daemon had no worker-evidence intake

- First configured-daemon delivery trace failed to reach Repair: operations showed Continue repeatedly publishing changing candidate observations until the instruction limit because `ProviderComposition` always returned an empty `workerClaims` list. That is a real runtime gap hidden by the earlier composition fixture's manually added claims.
- Fixed locally in `src/providers/opencode.ts` and `src/providers/composition.ts`: visible completed assistant text is read; Continue/Repair prompts request `ANVIL_EVIDENCE <obligation-id> <full-candidate-sha>: <claim>`. Only a completed assistant report naming an approved obligation and exact currently observed GitHub Candidate is admitted as worker evidence, attributed to Session. It remains a self-report, never independent review.
- The configured-process regression in `test/daemon-configured-process.test.ts` deliberately makes Repair's report name stale SHA1 while the remote Candidate is SHA2. It asserts a further Continue for SHA2, then a matching SHA3 report advances the CI/integration path. `test/providers/opencode.test.ts` “OpenCode message projection preserves visible assistant text for worker claim parsing only” passes; visible reasoning is excluded.
- The daemon trace covers a Bun child + SQLite + local Sandbox/OpenCode/GitHub/Mergify HTTP fixtures: failing check→Repair→stale worker-claim rejection→Continue→stale-check Wait→pending Wait→restart→pass→PR lost-ack recovery→queue Wait→foreign PR Escalate→wrong-head non-conclusion→registered exact delivery Conclude. It asserts three prompts, two Continue Operations, one Repair, one Integrate and one PR creation. Commit/push is exercised through the Git process/helper and the branch observer reads the bare ref; required checks, PR/Mergify state and provider execution remain fixture observations. The local Lease adapter has no way to advance to expiry for the requested expired-Lease run.
- A real deployed worker publication path remains blocked on an ephemeral Assignment-bound Sandbox capability/helper bootstrap and validation of receive-pack ref enforcement beyond the loopback fixture. Returning the repository-wide token directly would not enforce ref scope; it is not delivered through prompts or stored in DB/remotes.

## New finding F-NEW-03 — worker credential service boundary implemented, Sandbox handoff open

- Incumbent source was inspected read-only at `origin/main:crates/anvild/src/github.rs`, `origin/main:runtime/anvil-credential`, and `origin/main:docs/api.md`. Its HMAC session capability renews only after checking a live session; it does not bind this rewrite's Commission Attempt/Lease or target ref.
- `src/providers/git-credentials.ts` reuses the single runtime `GitHubAppBroker`, signs Commission/Assignment/Attempt/OpenCode Session/Sandbox Workspace/repository/ref/controller epoch/expiry claims, serves a `git`-purpose contents-only credential and contains the standard Git helper executable entry point. `ApplicationService.authorizeWorkerGitCapability` checks active Commission/Attempt, exact Assignment and durable provision/Session Operations, canonical repository/ref, current owner epoch, Lease validity and deadline. `/v1/git/credentials` is Hono-mounted, and `src/main.ts` shares the existing GitHubAppBroker plus controller-only signing-secret file.
- `test/providers/git-credentials.test.ts` runs actual `git credential fill` in a separate pinned Git process against the Hono endpoint and a loopback GitHub App token service. It asserts broker-minted `contents:write` output, refresh near token expiry, controller/service+SQLite restart, and denial for wrong repository/Commission/Assignment/Attempt/Session/Workspace/controller epoch/ref, stale/expired Lease, expired capability, held/concluded Commission, `gh` purpose escalation, unsupported method, and insecure capability-file mode. App signing key/capability are not in Git's helper output or error text; raw token is absent from remote URL, durable Commission/Operations, and helper errors.
- `nix develop -c bun test test/providers/git-credentials.test.ts` — passed 1 test / 58 assertions. Full local checks: `just check` 94 tests / 1121 assertions; `just ci-check`, `just ci-verify`, `nix run .#sdlc -- install --check` passed. Clean-clone results for this credential-service commit are pending.
- The test runs real `git push` through the helper into a loopback `git-http-backend` bare repository and verifies the updated ref/SHA with `git rev-parse`. A receiver pre-receive hook rejects wrong and multi-ref updates. This is local branch-policy fixture evidence, not a deployed GitHub ruleset or an Anvil ref-enforcing proxy.
- Limits: Git credential fill necessarily returns an extractable repo-wide installation token to that worker process until GitHub expires it; a signed target ref checks issuance but does not confine later token use. Protected branch rules protect only configured refs. The actual pushes use a loopback `git-http-backend` fixture with a local pre-receive hook, not live GitHub. The Sandbox has no capability-file bootstrap or bundled helper image yet. FS-10 remains IN_PROGRESS.

## Successor checkpoint — authority across asynchronous boundaries

Successor branch `anvil/anvil-first-slice-completion-58824672` starts at the
published PR #123 head `f6723b79d5a938a86c6770660969a1298abde148` (confirmed
with `git fetch origin` and `gh pr view 123`). The predecessor branch is preserved.

- `src/application.ts` now rechecks Lease authority after provider observation,
  immediately before prepared/retry submission, after dispatch, and after remote
  outcome inspection. The daemon supplies an explicit wall clock so Lease expiry
  during I/O cannot be evaluated against the start-of-poll timestamp. Deterministic
  callers can supply a controlled clock. Expired/future grants fail closed.
- `test/authority-boundaries.test.ts` adds takeover, expiry, unavailable Lease,
  loss just before submission, and loss after remote acceptance cases. They assert
  persisted Operations and dispatch counts: no work prepared after observation
  authority loss; prepared intent survives submission denial; a successor submits
  the original prepared ID once; a remotely accepted/submitted Operation is
  inspected by the successor without replay or rewriting its original owner.
- `nix develop -c just check` passed: 100 tests, 1163 assertions, formatting,
  strict TypeScript, locked install, generated lock match and negative drift probe.
  An initial targeted run exposed an incorrect test expectation that a successor
  could not submit prepared intent; the test now verifies legitimate successor
  submission with immutable original owner and one dispatch. An initial full
  check caught fixture forwarding arity errors, corrected before the passing run.
- Scope: FS-04/05 asynchronous-boundary regressions only. The daemon's Lease
  implementation is still local-only and does not coordinate multiple processes;
  Kubernetes Lease and independent Workspace/reviewer isolation remain open.
  Lease reads cannot fence already accepted remote writes. No FS status is
  promoted and the image/shared-Nix failing gates are preserved.

## Successor checkpoint — operational Ledger and submission preconditions

- Schema v5 (`src/persistence/migrations/0005_operational_views.sql`) retains the
  last provider observation/result and changed-decision/error history. Generation,
  state version, timestamps and sources remain inspectable; stale-version or
  reordered records cannot overwrite newer views. Polling does not increment the
  Commission version or append duplicate history. These derived records are not
  another Operation journal and are not dispatch/acceptance inputs.
- `src/operational.ts` and domain-owned `acceptanceGaps` provide read-only views;
  HTTP `/api/commissions/:id/projection`, paginated `/history`, MCP
  `get_commission_projection` and `get_history` use the same source. Existing
  Commission/Operation endpoints retain their contracts.
- Real operational UI in `web/` uses authenticated same-origin daemon data and
  typed hold/resume/amend commands, with an in-memory token and no mock telemetry.
  Campaign grouping, missing steering/preview links and unavailable metrics are
  labeled. `test/ui.test.tsx` uses React component interactions through real
  Hono/ApplicationService/SQLite; it is not a rendered-browser/screenshot review.
- New source-review finding: persisted prepared/retry intent previously retained
  submission permission after an operator hold, changed generation/Candidate,
  inactive Attempt or exhausted deadline/cost. `evolveOperation` now revalidates
  these preconditions for submission while allowing inspection/outcome recording.
  `test/submission-preconditions.test.ts` includes durable held-prepared→resume
  execution with zero effects while held and one original-ID dispatch on resume;
  it also preserves the final reserved instruction at the exact instruction limit.
  Invalidated prepared intent fails closed; governed cancellation/replacement of
  that intent is still an open recovery gap.
- `nix develop -c just check` passed: **105 tests / 1251 assertions**, locked
  dependencies/drift-negative probe, formatting and strict TypeScript.
- `nix develop -c just ci-verify` passed (the Nix-sandboxed full TypeScript/test
  derivation); `nix run .#sdlc -- install --check` passed.
- `nix develop -c just ci-check` **failed**, exit 1, at the retained
  `sandboxImageGate`: `PASS IMAGE-CONTENT` then `BLOCKED/INCOMPATIBLE` because no
  pre-provision contract guarantees the closure before the shared `/nix/store`
  overlay. The signature/derivation-add security finding is also still open.
- `nix build .#ui .#daemon .#checks.x86_64-linux.daemonSmoke --no-link -L`
  passed after an initial dependency-fetch command exceeded its 120s tool timeout
  and was rerun with 300s. Current inspected outputs were
  `/nix/store/8h062ddhvy39cl4avn7hwfa3mvdi4syf-anvil-ui-0.1.0` and
  `/nix/store/wmm97skz24c9v3rjw85vl8j0lhb2qq4d-anvil-daemon-0.1.0` (subsequent
  source/document changes may change input-addressed store paths). The daemon
  installs production dependencies only and embeds the built UI. Non-root smoke
  verifies built HTML/JS, CSP, denied unauthenticated API, no non-asset file exposure,
  health/readiness, schema v5, SIGTERM and SQLite restart persistence. No OCI
  daemon/UI image, read-only-container process or Kubernetes execution is claimed.

## Remaining local work / stopping status

### Exact published-source replay

Draft successor [PR #124](https://github.com/blogle/anvil/pull/124) targets `v2` and
preserves PR #123's head. Its implementation source is
`d4a002341e91a7e094abdc4bd395a9b58697f8f4` (preceded by authority fix `5945dc5`).
The evidence-only follow-up records this replay:

```sh
git clone --local --no-hardlinks --branch anvil/anvil-first-slice-completion-58824672 /home/anvil/workspace/anvil-first-slice-completion /tmp/opencode/anvil-successor-d4a0023
# In that fresh clone at d4a002341e91a7e094abdc4bd395a9b58697f8f4:
nix develop -c just check
nix develop -c just ci-check
nix develop -c just ci-verify
nix run .#sdlc -- install --check
nix build .#ui .#daemon .#checks.x86_64-linux.daemonSmoke --no-link -L
git status --short
```

Results: `check` exit 0, **105 tests / 1251 assertions**; `ci-verify` exit 0;
SDLC install check exit 0; Nix packages/process smoke exit 0; final Git status
empty (generated lock unchanged). `ci-check` exit 1 at unchanged
`sandboxImageGate`, with the exact closure-preseed `BLOCKED/INCOMPATIBLE` diagnostic
above. Clean-clone built outputs:
`/nix/store/dx6j3g907qnszc14kk4knl3473gxf2w7-anvil-ui-0.1.0` and
`/nix/store/dni24aw8cbph2nz7jf6prqbb89s72apd-anvil-daemon-0.1.0`.
The clone used a new working tree and dependency installation; Nix downloads and
build cache were shared. No hermetic machine reset or independently executed
review is inferred. GitHub PR checks are separate from these local outcomes.

This session has not reached `LOCAL_SLICE_READY`. No complete FS-01–FS-14
obligation is promoted to VERIFIED from these narrower checks. See
[the successor handoff](#successor-handoff) for the exact remaining
work and why a deployment acceptance request is not yet executable. FS-15 remains
`BLOCKED_EXTERNAL`; unresolved local implementation is not an external blocker.

<a id="approved-contract"></a>
## Approved contract

**Status:** Approved development acceptance contract · **Target:** `v2` · **Commission:** Anvil autonomous first slice · **Predecessor PR:** [#123](https://github.com/blogle/anvil/pull/123)

This section is the **authoritative, stable definition of FS-01 through FS-15** for the current development campaign. It codifies the previously approved obligation-driven steering. It is not a replacement for [the product specification](../../spec.md) or [architecture](../../architecture.md); those remain authoritative for domain semantics. The [evidence ledger](#evidence-ledger) records progress and verification against these IDs. The implementation worker cannot relax, remove, or silently reinterpret any obligation. Any material changes require an explicit approved amendment, not an agent-created revision.

### Objective

Build the first operational slice of pre-1.0 Anvil: a Bun/TypeScript **autonomous** development controller that owns bounded Commission execution, state, OpenCode and sandbox interaction, GitHub/CI/Mergify integration, recovery, observability, API/MCP, and minimal UI. The outer convergence loop—not ChatGPT—must diagnose gaps and initiate authorized continuations, corrections, verification, and integration. The new implementation may not replace the incumbent until separately demonstrated to **match and exceed** its capabilities and reliability.

### Authority and environment constraints

- **No direct live cluster access.** The implementation worker must not use addrspace Kubernetes credentials or run live cluster commands, including kubectl and Helm. No kind, k3d, or simulated local cluster is authorized.
- **No dotfiles mutations.** Deployments are controlled separately through the dotfiles repository. The worker must not edit, commit, push, create PRs for, merge, or overwrite dotfiles manifests—especially the existing production `anvil` namespace. A future test namespace requires separately authorized dotfiles work.
- **No production cutover or release.** No merge to main/master, no replacement of existing deployment, no release/tag or SemVer major, and no automatic merge of PR #123. Implementation PRs target `v2`.
- **Local-first development.** Use `flake.nix` and pinned `flake.lock` to provide all tooling; Bun is the only application runtime/package manager. Do not depend on undeclared system Node, npm, Rust, or imperative installers. Use declarative Nix, including later container packaging.
- Follow `skills/software-craft/SKILL.md`: functional core / imperative shell, explicit immutable domain facts, closed state variants, no generic snapshot mutation API, minimal machinery, tests demonstrating behavior, no speculative frameworks. Follow SDLC changelog-fragment rules.
- Read the latest PR/branch and evidence ledger before attempting work. The worker controls implementation techniques and sequencing inside the approved objective, not acceptance criteria.

### Immutable obligations

### FS-01 — Reproducible Bun/Nix/SDLC toolchain

A clean clone can enter `nix develop`, install locked Bun dependencies, run fast format/type/unit/property checks, and run separate pinned Nix and SDLC CI/verify checks. `bun.lock` is the sole JavaScript dependency authority; generated `bun.nix` is derived and checked for drift. No obsolete Rust/Cargo/Crane scaffolding, Rust images, parallel npm lockfile, or undeclared host Node/npm toolchain. Nix expressions remain simple, modular by real responsibility, and declarative. Regenerate SDLC-managed files such as `renovate.json` through official tooling. Externally meaningful changes use SDLC `.changes/*.json` fragments with patch/minor only; do not manually edit `CHANGELOG.md`.

**Required evidence:** exact clean-clone/Nix/just and SDLC commands, output and exit statuses, generated lock drift negative check, package/build inventory, GitHub checks.

### FS-02 — Pure, cohesive domain engine

A single functional domain core owns Commission identity, lifecycle, decision authorization, state evolution, evidence policy, and Operation transition constraints. Pure `decide`/`evolve` or an equivalently cohesive interface receives immutable explicit inputs and yields exhaustive, typed results. No I/O, hidden global time/randomness, in-place input mutation, or provider calls. SQLite/HTTP/MCP/UI must not redefine domain policy. Repeated `Wait`, `Hold`, or `Escalate` under identical authoritative facts is a **no-op**: no new Operation, no unnecessary state version or SQL write. Organize production in conventional `src/`, tests in `test/`, and by domain responsibility, not transitional language suffixes.

**Required evidence:** source review plus tests for deep input immutability, exhaustive decisions, unchanged-state stable polling/version/DB row, and negative unauthorized transition cases.

### FS-03 — Governed intent, authority, and amendments

Only typed and properly authorized commands may create/admit, hold/resume, or amend an approved Commission. Objective, repository/target, budget, obligations, acceptance policy and authority are protected from generic snapshot updates, worker reports, and forged JSON. Amending requirements requires an approved actor and expected specification generation; modified criteria invalidate affected previous evidence/approval, unchanged criteria may retain applicable evidence. Terminal conclusion is immutable to ordinary amendments, unless a separate explicitly governed reopen contract is implemented. SQLite compare-and-swap must reject stale concurrent writes.

**Required evidence:** forged payload and wrong-actor tests, stale-generation/concurrent CAS tests, worker attempt to waive a criterion, terminal amendment rejection or governed reopening test.

### FS-04 — Durable Operations and crash-safe idempotency

Exactly one authoritative SQL Operation journal; persist approved transition and prepared Operation **atomically before external mutation**. Operation identity and target/preconditions are stable across restarts. A repeated logical instruction must not gain a new ID or cause duplicate OpenCode/GitHub side effects. An ambiguous external acknowledgement requires reobservation; absence alone is not safe-retry proof. Provider-proven safe retry retains the same logical identity and bounded retry count; `retry_authorized` remains unresolved until resolved. Ordered transactional migration tracking and SQLite reopening preserve state.

**Required evidence:** crash matrix at prepared, submitted, external effect before acknowledgement, ambiguous, retry authorized, during retry, and outcome recorded; real SQLite reopen; fake-provider dispatch counts; negative duplicate-operation counterexamples.

### FS-05 — Controller succession and exclusive Workspace writer

Only the actual current controller Lease holder with valid owner identity/epoch may authorize **new** mutable external operations. Lease ownership is not a remote exactly-once fencing mechanism. The original Operation's owner identity remains immutable, but a legitimate successor may inspect and record the predecessor's already-dispatched outcome without impersonation or replay. Controller A loses Lease, B acquires it, B resolves A's Operation, stale A cannot issue further writes. At most one authorized mutable writer per Workspace; independent verifier uses a separate snapshot/checkout.

**Required evidence:** A dispatch/crash -> B takeover/remote inspect/outcome test; stale A rejected; competing controllers/CAS; ambiguous outcome across takeover; no duplicated instruction or writer.

### FS-06 — Sound budget and stopping semantics

`maxAttempts` restricts creation of a **new Attempt**, not continuation of an already admitted first Attempt. Instruction/repair/cost/deadline limits apply to the effects they actually constrain. Usage monotonically persists across restarts, strategies, and context refresh. Repeated failure/unchanged evidence must lead to bounded waiting, strategy change, hold, or actionable escalation, not an infinite loop. Exhaustion prohibits new costly work but does not erase or block recording an already-valid authoritative delivery result, subject to authority and evidence.

**Required evidence:** zero/one/limit/overlimit tests, first Attempt with `maxAttempts=1`, exhausted budget with externally merged Candidate, restart budget retention and nonproductive-loop counterexamples.

### FS-07 — Candidate-, specification-, and delivery-bound evidence

Worker statements are submitted worker evidence, not independent acceptance. Every criterion's evidence is bound to applicable specification generation/criterion, immutable Candidate revision (and applicable dependency/check context), provenance, freshness, and disposition. Independent review is optional unless explicitly required. Candidate/spec changes invalidate affected verification, evidence, and approval. Pending checks/queued Mergify produce healthy waits, not repeat effects. Conclude only after authoritative evidence that the **registered PR in the approved repository and target** integrated the correct Candidate, with configured healthy checks and acceptance; a different PR with the same SHA cannot satisfy delivery.

**Required evidence:** foreign PR/repository/target, stale spec and SHA, worker-only vs required independent review, green-only/open-only/queued-only, future/expired observation, changed Candidate cases.

### FS-08 — Real autonomous outer convergence

A running controller, rather than a manually scripted runner or ChatGPT, decides and executes authorized `Wait`, `Continue`, `Repair`, `RefreshContext`, `ChangeStrategy`, `Verify`, `Integrate`, `Hold`, `Escalate`, and `Conclude` as appropriate. It persists intended effects, observes execution/git/checks/PR state, reacts to idle **and** in-flight repeated failures/context pressure at safe interruption boundaries, reobserves before retry, and stops wasted turns during external waits. Continuation prompts reconstruct Campaign/Commission/Assignment/Attempt/objective/Findings/remaining gaps from durable artifacts, not full transcript replay.

**Required evidence:** trace-driven autonomous lifecycle that chooses each action, in-flight watchdog tests, healthy wait/no-model-turn tests, bounded strategy change, restart and context-reconstruction tests.

### FS-09 — High-fidelity local test pyramid

Fast isolated domain/property/model tests with independently specified reference invariants, reproducible seeds and shrinking. Real SQLite, local HTTP and multi-process provider/test harness (where relevant) exercise same domain/application code as the daemon without Kubernetes or live credentials. Test duplicate/out-of-order notifications, stale observations, random restarts/ownership changes, active tool failures, CI fail/repair/pending/pass, PR queue/merge, and unknown Operation outcomes. Tests assert actual persisted state and external dispatch counts, not just decision labels.

**Required evidence:** exact replay commands, named tests, seeded failing/regression examples, a whole autonomous Commission lifecycle over real local state and local provider HTTP.

### FS-10 — Real production-intended provider adapters, locally validated

Implement bounded adapters for agent-sandbox provisioning/Workspace lifecycle, OpenCode session/messages/turn observation/instruction, credential separation and scopes, GitHub branches/PR/checks/CI, and Mergify queue/merge. Preserve provider-owned external IDs, correct failure/unavailable distinctions, and safe idempotency/reobservation semantics. Fakes support development but **must not substitute** for real adapters; use protocol-compatible local servers and/or recorded contract fixtures to validate adapters without touching the live cluster. Mark actual live provider integration separately unverified.

**Required evidence:** adapter contract tests, auth-scope assertions, mapping of real provider responses to canonical observations and operations, unsafe-retry counterexamples and honest externally unverified integrations.

### FS-11 — Runnable Bun daemon, authenticated HTTP and MCP

One executable Bun daemon runs migrations, persists Commissions and Operations, reconciles unattended work and recovers on restart. A Hono HTTP API and MCP expose the **same** authorized commands and read projections, rather than divergent policy logic: propose/admit, status/history/evidence, hold/resume, governed amend, steer existing Assignment without racing autonomous execution, and actionable escalation. Read views distinguish provider fact, worker assessment, observation freshness and pending work.

**Required evidence:** real daemon process startup via Nix/Bun, real local HTTP/MCP clients and auth-denial cases, persisted restart recovery and no duplicate effect after restart.

### FS-12 — Real operational UI

React/Vite, TanStack Router+Query, Tailwind/shadcn styled in the existing Ledger aesthetic; use actual authenticated API projections for Inbox, Campaign/Commission, Operations/evidence/Findings, current decision and next wake, and authorized steering/hold/amend. OpenCode Session and sandbox-preview links navigate to external actual targets rather than nested preview simulations. Do not present static mock data as live telemetry or create a second authority in the UI.

**Required evidence:** runnable UI against the real local daemon, browser/component integration checks for views and interventions, screenshot/preview reference plus the executed tests.

### FS-13 — Declarative build and deployment readiness

Build/package the actual Bun daemon/UI and sandbox runtime through declarative Nix, using nix2container with explicit sensible layering where useful, without arbitrary imperative package installation. Locally verify image/artifact contents, startup, migration, config/credentials assumptions, probes and ports. Produce a narrow deployment interface contract (images/digests, namespaces, secrets, health/readiness, compatible agent-sandbox and shared Nix interfaces) for a **separately authorized** dotfiles-managed namespace. Do not deploy or modify dotfiles.

**Required evidence:** exact pinned Nix build and package inspection/startup commands, deployment contract, known missing live validations.

### FS-14 — Incumbent parity and cutover protection

Inspect the existing `main/master` implementation and existing deployment contracts. Maintain an evidence-backed feature-by-feature matrix showing incumbent behavior and what the rewrite has implemented, verified, or lacks, including unattended convergence, sandbox/OpenCode, watchdog, GitHub/CI/Mergify, UI/API/MCP, recovery, auth, observability, provisioning and costs. Do **not** recommend moving Anvil development to the rewrite until capabilities and reliability match **and materially exceed** the incumbent.

**Required evidence:** grounded incumbent source references, runnable comparison or identified gaps, explicit cutover prohibition until independently accepted.

### FS-15 — Separately authorized live acceptance (external gate)

Full first-slice acceptance requires actual integration on an isolated addrspace namespace **deployed exclusively through an independently authorized dotfiles workflow**. Demonstrate real sandbox provisioning, OpenCode work, GitHub/CI/Mergify PR delivery, controlled interruption/recovery and authoritative merge, with the current production `anvil` namespace untouched. The implementation worker is **forbidden** from executing this or editing dotfiles. It may prepare a concrete acceptance runbook and required evidence. This obligation must be `BLOCKED_EXTERNAL` for this worker; it can only become `VERIFIED` after separate authorized execution and independent validation.

### Initial independently identified findings — close by test, not by assertion

- **G01 / FS-05:** successor B cannot resolve predecessor A's Operation because `evolveOperation` incorrectly requires A's owner identity to equal B's current authority.
- **G02 / FS-04:** `retry_authorized` omitted from unresolved predicate; restart can issue a new logical instruction.
- **G03 / FS-07:** delivery merge observation lacked registered PR, repository and target binding.
- **G04 / FS-06:** global attempt exhaustion blocks execution of the existing first Attempt when `maxAttempts=1`.
- **G05 / FS-03:** ordinary specification amendment accepted after terminal conclusion.
- **G06 / FS-02:** unchanged Wait/Hold/Escalate unnecessarily increments the durable Commission version.

For each finding: reproduce the old failure with an adversarial regression; implement the smallest cohesive fix; demonstrate the positive and negative behavior using actual test execution.

### Evidence ledger and convergence protocol

For **every FS ID**, record `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, `BLOCKED_EXTERNAL`, or `FAILED` in [the evidence ledger](#evidence-ledger), with source path and commit, test paths/names, executed command/result, adversarial counterexample, and remaining limitations. Do **not** use `NEEDS_CRITERIA`: the criteria are all in this plan. A worker claim, green CI check, or unexecuted test is not sufficient for the relevant gate. Never claim external/production integration from a local stub.

After each coherent checkpoint, update the evidence ledger, preserving objective, progress, exact failure traces, outstanding FS IDs and the next authorized action. Reconstruct continuation context from those durable artifacts rather than a full prior agent trajectory. If an obligation remains unverified, its gap remains visible. An issue is not 'done' because its code exists.

### Stopping rule / authority boundaries

1. **REVIEW_READY_CORE:** G01–G06 fixed with adversarial tests, PR #123 updated and relevant Bun/Nix/SDLC checks green; local domain core reviewable. This does **not** close FS-08–FS-15.
2. **LOCAL_SLICE_READY:** FS-01 through FS-14 all **VERIFIED**, with reproducible evidence. FS-15 is `BLOCKED_EXTERNAL` with runbook, and the PR(s) are ready for independent review. This is the maximum acceptance level available to this implementation worker.
3. **FULL_FIRST_SLICE_COMPLETE:** FS-01 through FS-15 independently accepted, including the separately authorized live gate. **Not available to the worker.**
4. **BLOCKED_OR_EXHAUSTED:** Identify exact affected FS IDs, attempted remedies, evidence, and precise missing authority or requirement. Stop only when continuing local work is truly impossible or budget is exhausted, not because FS-15 cannot be executed.

Do not silently modify this contract. The worker must not self-certify acceptance; submit verifiable evidence for independent review. Keep PRs reviewable and do not auto-merge.

<a id="incumbent-parity"></a>
## Incumbent parity and cutover protection

Baseline inspected read-only from `origin/main` at
`b55f9b0ecbf89309832c6dcdc9a615cbc4e15f8b`. This matrix compares the contract
in [the approved obligations](#approved-contract) with concrete incumbent paths and the rewrite.
It is a development gap inventory, not an independent cutover assessment.

| Capability | Incumbent evidence (`origin/main`) | Rewrite evidence | Assessment |
|---|---|---|---|
| Durable control-plane process and HTTP | `crates/anvild/src/main.rs`, `crates/anvild/src/lib.rs`, `crates/anvild/src/store.rs`; service initialization, routes, durable SQLite-backed sessions/tasks. | `src/main.ts`, `src/daemon.ts`, `src/persistence/sqlite.ts`; local process restart and HTTP tests in `test/daemon-process.test.ts`, `test/daemon.test.ts`; opt-in adapter factory in `src/providers/runtime.ts`. | Rewrite boots and persists basic Commission state and can opt into locally contract-tested providers; default remains unavailable. No Campaign aggregate or incumbent route coverage. Incumbent ahead. |
| MCP | `crates/anvil-mcp/src/main.rs`; Streamable HTTP facade, tools for sessions, batches, attempts, status, activity, steering, and operations. | `src/daemon.ts`, MCP endpoint/tools; `test/daemon.test.ts` protocol initialize/tools/list and shared durable command test. | Rewrite supports initial Commission tools only; no full parity of task/session/activity/campaign surface. Incumbent ahead. |
| Pure domain and reconciliation | `crates/anvil-core/src/lib.rs`, `crates/anvil-reconcile/src/lib.rs`, `crates/anvild/src/store/scheduler.rs`; typed core/task reconciliation with fixture/reference behavior. | `src/domain.ts`; `test/domain-core.test.ts` seeded fast-check model and G01–G07 cases. | Commission-specific model implemented locally; no demonstrated feature/reliability superiority. |
| Durable Operations and restart | `crates/anvild/src/store.rs`, `crates/anvild/src/store/scheduler.rs`; durable task/session state, request ids, operation handling, migration fixtures. | `src/persistence/sqlite.ts`; `test/store.test.ts` SQL reopen, CAS, ambiguous outcome, retry authorization tests. | Narrow local Operation journal proven; full crash matrix and external remote recovery parity remain incomplete. |
| Agent sandbox and Workspace | `crates/anvild/src/lib.rs` (`KubeSandboxApi`), `crates/anvild/src/local.rs` (`LocalSandboxApi`), `k8s/base/*`, vendored agent-sandbox v1.0.2 contract. | Local Agent Sandbox V1beta1 REST adapter `src/providers/agent-sandbox.ts`, configured factory `src/providers/runtime.ts`, and API fixture `test/providers/agent-sandbox.test.ts`; no cluster exercised. | Incumbent has actual local and Kubernetes-backed lifecycles; rewrite has a local protocol-tested resource client only. Live controller, Workspace/storage, auth/RBAC and upgrade continuity remain unverified. |
| OpenCode execution, sessions, watchdog | `crates/anvild/src/lib.rs` `OpenCode` client, message/run/status/activity routes and recovery; `crates/anvild/src/local.rs` starts real local OpenCode workers. | V2 session/message/turn adapter `src/providers/opencode.ts`; Sandbox/session composition in `src/providers/composition.ts`; 5-second bounded watchdog observations; safe-boundary interrupt Operations; filtered SSE wakeups/reconnect; durable hierarchical context; local HTTP/daemon restart tests. Pinned v2.0.26 source contracts were inspected in `docs/provider-contracts/opencode-v2.md`. | Rewrite now has local fixture/process evidence for active tool failures, context pressure, stuck progress, interruption acknowledgement recovery, and event wakeups. Still unverified against the deployed binary/live session; randomized loss/order traces, complete watchdog policy/telemetry and provider credential review remain. Incumbent materially ahead. |
| Git/GitHub/credential scope | `crates/anvild/src/github.rs` App token broker, capability-bound repository/session credential, least-privilege profiles; `crates/anvild/src/lib.rs` PR/credential integration. | Repository-scoped App token broker, branch/PR/check and PR-create client in `src/providers/github-app.ts`, `src/providers/github-delivery.ts`; local scopes and ambiguity tests. Configured factory uses controller credentials; no worker token handoff. | Rewrite has local token/REST contract coverage; controller/worker identity isolation, pushes, session capabilities and live permissions remain unverified. Incumbent materially ahead. |
| CI/Mergify and delivery | `docs/deterministic-task-reconciler.md`, `docs/reconciler-integration-research.md`, `crates/anvil-reconcile/fixtures/*`, GitHub and delivery references in `crates/anvild/src/lib.rs`. | GitHub branch/check/PR projection, Mergify queue observer, and `GitHubWorldObserver` in `src/providers/`; composed local merge fixture in `test/providers/composition.test.ts`; G03 domain identity validation. | Local branch/check/queue/merge contract path passes fixtures; no commit-status contexts, required-check profile/production review, live Mergify, or real daemon configured run. Incumbent ahead. |
| UI | `web/src/*`, `web/index.html`, `web/state.test.js`, `docs/frontend-implementation.md`; real API-backed session list/detail/files/activity controls. | Real React/Vite/TanStack/Tailwind Ledger in `web/`, Nix `ui` output embedded in daemon; `test/ui.test.tsx` executes authenticated data and hold/resume/amend flows against Hono/SQLite. | Partial operational UI now exists. Full Campaign semantics, steering, external Session/preview links, diff/review, full Findings and browser/visual review remain missing; incumbent broader, no parity claim. |
| Preview routing | `crates/anvild/src/lib.rs`, sandbox router deployment and preview routes documented in `docs/api.md` and `docs/architecture.md`. | No preview gateway/URL support. | Incumbent capability not present in rewrite. |
| Declarative build/deployment and shared Nix | `nix/images.nix`, `nix/sandbox.nix`, `k8s/base/*`, `runtime/nix-daemon-entrypoint`, `docs/nix-shared-volume-ownership.md`. | Nix `daemon`/`ui` artifacts with non-root startup/restart smoke; worker nix2container image with content/closure preflight proofs. `sandboxImageGate` fails on missing closure preseed; Nix untrusted derivation-add negative remains open. | Daemon/UI packages run locally; no daemon OCI/deployment base, safe complete shared-Nix startup/security contract or accepted container runtime. Deployment readiness blocked. |
| Security, observability, cost | `crates/anvild/src/github.rs`, capability signer, scoped token tests, structured service diagnostics, activity state/read projections in `crates/anvild/src/lib.rs`; inspect complete configuration/telemetry contracts before equivalence claims. | Bearer token HTTP auth, SQLite evidence/outcome; no multi-principal identity, structured operational metrics, usage accounting projections or cost estimates. | Incumbent has broader security/runtime telemetry; rewrite incomplete. Cost parity not yet evidenced either way. |

### Cutover rule

This evidence does not justify moving Anvil development to the rewrite. No
capability/reliability comparison currently shows the rewrite matching or
materially exceeding the incumbent. Keep `main` as the parity baseline until an
independent review of this matrix, runnable comparative scenarios, and all
required local acceptance obligations support a stronger conclusion.

<a id="successor-handoff"></a>
## Successor local-slice handoff

### Outcome and source boundary

**BLOCKED_OR_EXHAUSTED — prior session execution budget exhausted, local work remains.**
This is a published implementation checkpoint, not `LOCAL_SLICE_READY`, independent
acceptance, or a request to execute deployment. The approved FS contract is unchanged.

The successor work branch is `anvil/anvil-first-slice-completion-58824672`, published
as draft [PR #124](https://github.com/blogle/anvil/pull/124) against `v2`, starting
from PR #123's recorded and fetched head
`f6723b79d5a938a86c6770660969a1298abde148`. First successor increment `5945dc5`
revalidates Lease authority across provider I/O. The operational Ledger increment
is `d4a002341e91a7e094abdc4bd395a9b58697f8f4`. The later evidence-only commit records
clean-clone replay and the PR link; it does not change implementation.
The predecessor branch and PR remain preserved. Implementation PRs target `v2`.

Read [the evidence ledger](#evidence-ledger) for executed evidence and limitations, and run:

```sh
nix develop -c just check
nix develop -c just ci-check
nix develop -c just ci-verify
nix run .#sdlc -- install --check
nix build .#ui .#daemon .#checks.x86_64-linux.daemonSmoke --no-link -L
```

`ci-check` is expected to fail at the preserved `sandboxImageGate`; do not disable
it or describe the CI as green. The fast suite and Nix verify pass at this
checkpoint. The package smoke executes Bun, static UI serving, authentication,
SQLite schema v5 and process restart; the component test executes real commands.
Neither is browser/visual acceptance or independent semantic review.

### Per-obligation residual work

| FS | Current local evidence | Work still required for complete local verification |
|---|---|---|
| 01 | Locked Bun/Nix installs, generated-lock negative, format/type/tests and pinned verify executed. | Clean-clone replay at published successor SHA; complete SDLC/GitHub review. Aggregate flake check is red on FS-13. |
| 02 | Pure domain, frozen input, no-op SQL/version cases, projection gaps reuse domain evidence policy. | Exhaustive source/decision review with independent assessment. |
| 03 | Governed generation amendments, wrong actor/forgery/CAS and terminal cases; UI stale amendment denial. | Authority-freshness coverage beyond tested generation/principal cases; command attribution/audit. |
| 04 | Durable Operation identity, restart/lost-ack/local provider lifecycle tests; submission-precondition regressions. | Real process-kill failpoints at every write/dispatch boundary and randomized crash ordering; governed resolution of invalidated prepared intent. |
| 05 | Successor/stale-owner and new I/O-boundary tests preserve immutable Operation owner and no replay. | Actual Kubernetes Lease adapter and daemon wiring, exclusive Workspace writer, independent verifier snapshot. The current main-process Lease is local-only. |
| 06 | Persistent usage and bounded budgets; held prepared instruction cannot execute until resumed; final reserved instruction allowed at exact limit. | Randomized nonproductive/restart traces; deadline/takeover combination; invalidated-intent recovery. |
| 07 | Candidate/criterion/spec/PR/target identity and required-check fail-closed cases; explicit provenance in UI. | Complete independent evidence/freshness/invalidation matrix and reviewed required-check contract. |
| 08 | Configured daemon drives local delivery with real Git publication, CI repair/waits, restart and lost PR ack recovery. | Actual Sandbox helper/capability bootstrap, broader context/tool-boundary/event loss/reorder/restart traces. |
| 09 | 105-test fast suite and Nix verify, real SQLite/Bun child/local HTTP/Git lifecycle. | Multiprocess randomized failure pyramid and independently specified stronger reference invariants. |
| 10 | Real adapter implementations exercised against local protocol-compatible endpoints; Git helper and scoped broker tests. | Actual helper/capability bootstrap; provider compatibility; explicit worker repository-wide-token risk; verifier/Workspace isolation. |
| 11 | HTTP/MCP commands and shared durable projection/history; authenticated packaged-daemon startup/restart. | Campaign/Assignment/Findings/steering command completeness, durable command audit, Kubernetes Lease wiring. |
| 12 | Real authenticated Ledger and component hold/resume/amend evidence; compiled UI served by packaged daemon. | Full Campaigns/dependencies, review/diff/Findings, serialized steering, external actual links, browser screenshots/accessibility/visual acceptance. |
| 13 | Nix daemon/UI packages and worker image; package startup/assets/migration/restart smoke. | Daemon/UI OCI artifact/digests, narrow overlayable Kubernetes base, read-only-container startup, safe shared-Nix preseed/order/authorization, complete artifact/security review. Hard failing gate remains. |
| 14 | Grounded read-only incumbent inventory and partial parity matrix. | Refresh all stale matrix rows, execute comparative scenarios, complete independent source/reliability review. No cutover supported. |
| 15 | Prepared runbook only. | **BLOCKED_EXTERNAL**: separately authorized dotfiles-managed isolated deployment and independent execution/review. |

### Next authorized engineering milestones

1. Close end-to-end worker capability/helper handoff, with fail-closed transport
   policy and real local Sandbox bootstrap. Implement actual Lease coordination;
   do not promote the current local Lease stub to deployment evidence.
2. Finish governed Assignment steering serialized with autonomous dispatch and
   complete Campaign/Findings/review projections; extend Ledger with real links and
   browser evidence. The current Campaign screen deliberately only groups IDs.
3. Finish the shared-Nix contract as one complete startup/security boundary.
   Signature enforcement is not Nix protocol read-only authorization: predecessor
   `derivation add` finding remains failed. Preserve the negative tests.
4. Package reviewed immutable images and Kubernetes interface, run the full crash
   matrix/parity/review, then assemble the separately executable acceptance packet.

These are local engineering obligations, not requests for routine operator
decisions. No Kubernetes/dotfiles credentials are needed to continue them.

<a id="k8s_acceptance_request-not_executable"></a>
### K8S_ACCEPTANCE_REQUEST: NOT_EXECUTABLE

No deployment authorization is requested at this checkpoint. Material local gates
fail; inventing image digests or manifests would not produce an executable handoff.
Before converting this section into an executable request, record all of:

- exact reviewed source/PR and passing FS-01–FS-14 evidence;
- daemon/UI and worker OCI manifest digests and registry locations, with content
  and non-root read-only-rootfs process tests;
- namespace-specific declarative manifests/overlay and isolated service accounts,
  namespaced Sandbox/Lease RBAC, ingress/auth and egress/network assumptions;
- Secret **names/keys only** for operator auth, capability signing, GitHub App,
  OpenCode/model and sandbox profiles; tested worker/controller separation;
- SQLite persistent state/single-writer strategy and backups; Workspace PVCs;
  shared-Nix store/database exclusive owner, approved socket/build authorization,
  complete closure seeding before Pod startup, init ordering and GC roots;
- health/readiness/ports, compatible agent-sandbox/OpenCode revisions, external
  preview/session endpoints and required GitHub CI/Mergify policies;
- approved isolated failure-injection timeline, independent reviewer, evidence
  capture, production non-interference checks and declarative cleanup/expiry.

Only after those fields are concrete should an independently authorized dotfiles
operator be asked to execute the isolated namespace runbook. FS-15 remains
`BLOCKED_EXTERNAL`. The dormant dotfiles prep branch remains untouched/unqueued;
the documentation migration is now authorized and recorded below. No deployment,
merge, release or cutover is authorized. Historically the predecessor handoff also
left the `docs/plans` migration untouched/unqueued; the operator superseded that
documentation-only restriction for this checkpoint.

<a id="live-acceptance"></a>
## First-slice live acceptance runbook (prepared; not authorized for execution)

This runbook prepares the evidence boundary for FS-15. It is **not** approval to
deploy. The implementation worker must not access addrspace/Kubernetes, run
`kubectl`/Helm, operate kind/k3d, modify dotfiles, or touch the incumbent
production `anvil` namespace. Execution requires a separately authorized
dotfiles operator and an independent acceptance reviewer.

Stable operating procedures are maintained in [operations](../../operations.md#deployment-and-recovery-procedure).
The sequence below retains the approved campaign-specific execution and evidence
requirements; it cannot run until the local packet and independent authority gate
above are satisfied.

### Required authority and isolation

Before execution, the independent operator records:

1. Explicit approval for one isolated test namespace and its expiry/cleanup
   window.
2. The dotfiles PR and merged commit that declare all resources, secret
   references, images by digest, storage, ingress/preview, Nix daemon, and
   agent-sandbox controller compatibility.
3. A reviewed before/after inventory proving the existing production `anvil`
   namespace and its resources are not targeted or modified.
4. The GitHub App installation, repository, branch rules, required CI checks,
   Mergify policy, OpenCode profile, and worker-vs-controller credential
   permissions for the test Commission.
5. An identified independent reviewer and the approved FS-01–FS-14 local
   evidence ledger revision to use as test input.

Any missing authority, production namespace impact, unbounded credential,
unreviewed image/secret, or ambiguous target stops the run before deployment.

### Execution sequence

1. **Deploy declaratively.** The dotfiles operator applies the authorized
   dotfiles change to the isolated namespace only. Record the deployment commit,
   image digests, health/readiness results, allocated Workspace/PVC identities,
   service endpoints, and secret names (never secret values).
2. **Verify isolation and readiness.** Independently inspect namespace labels,
   service accounts/RBAC, network policy, ingress/preview access, agent-sandbox
   controller readiness, shared Nix daemon/store ownership, read-only worker
   mounts, and that the production namespace inventory is unchanged.
3. **Create one bounded Commission.** Record approved objective/specification
   generation, repository, work branch, integration target, obligations,
   required review policy, budget, controller Lease identity, and registered PR
   identity. Confirm the Assignment's GitHub credential is repository-scoped
   and cannot obtain controller/App credentials.
4. **Exercise autonomous work.** Through the normal authenticated API/MCP/UI,
   admit the Commission and let Anvil provision its Sandbox/Workspace, bind the
   OpenCode Session, dispatch one authorized instruction, observe Candidate and
   CI, repair a deliberately seeded local failure, and report obligation
   evidence. Capture the full durable Decision/Operation IDs and matching
   provider observations without copying transcripts or credentials.
5. **Exercise delivery.** Confirm the tested immutable Candidate SHA matches
   the registered repository, branch, PR, and target. Observe configured CI
   required checks, Mergify queue state, and final authoritative merge. Green
   checks, an open/queued PR, a same-SHA foreign PR, or worker report alone must
   not conclude the Commission.
6. **Exercise interruption and recovery.** In a separately approved test
   window, interrupt/restart the daemon after prepared intent, after provider
   submission, after a remote side effect before acknowledgement, while an
   operation is ambiguous, during safe retry, and after outcome persistence.
   Transfer the Lease to a successor. Verify successor reobservation does not
   replay the predecessor's turn, and stale controller writes are rejected.
7. **Close and clean up.** Verify Commission evidence and operation history;
   record provider IDs, final merged SHA, status of each configured acceptance
   obligation, errors/unknown outcomes, cost/usage sources, and independent
   reviewer result. The operator then removes only the isolated test resources
   through the authorized dotfiles workflow and verifies the production
   inventory remains unchanged.

### Required evidence packet

- Authorizing decision, dotfiles PR/commit, namespace identifier, and
  deployment resource/image digest inventory.
- Pre/post production namespace inventory diff proving no production change.
- Redacted health/readiness, authenticated API/MCP, and UI test outputs.
- Commission/Assignment/Attempt/Lease IDs, specification generation, budget
  before/after, Candidate SHA, repository/branch/PR/target IDs, check-run IDs,
  and Mergify/merge evidence.
- Operation failpoint timeline with dispatch count, original logical ID,
  restart point, reobservation result, retry authorization evidence, and final
  outcome. Include at least one adversarial unknown/foreign-identity case.
- Worker/controller credential-scope proof, secret-reference inventory with
  values redacted, and independent reviewer findings/approval.
- Cleanup result, final isolated namespace inventory, and production
  non-interference confirmation.

Until those separately authorized actions are completed and independently
reviewed, ledger status remains `FS-15: BLOCKED_EXTERNAL`. The runbook itself is
preparatory documentation, not external acceptance evidence.

<a id="migration-checkpoint"></a>
## Documentation migration checkpoint — 2026-10-30

### Decision log and approved scope

- Operator approved one documentation migration checkpoint on successor PR #124,
  preserving the predecessor and all FS-01–FS-15 obligations. This supersedes only
  the earlier deferral of `docs/plans` restructuring. Deployment authority is unchanged.
- Reconciled clean working branch and published PR #124 at
  `128b5f24ce08fa5397773ed10731cdebbd01090c`, containing predecessor
  `f6723b79d5a938a86c6770660969a1298abde148`. Existing implementation is the baseline.
- Consolidated contract, ledger, handoff, parity and live acceptance milestones
  here. Former public entry points are navigation-only pointers to this plan.
  Moved local daemon procedures to `docs/operations.md`; extracted durable domain,
  engine and runtime requirements into permanent specification/architecture.
  Prototype screens, Ledger presentation, research and ADR provenance are retained.
- Historical test counts/results and stale parity findings remain scoped to their
  original checkpoints. No FS status is promoted, no new acceptance evidence is
  inferred, and the failed Sandbox/Nix security boundaries remain failed/open.

### Migration verification and outcome

Executed on the migration working tree based on `128b5f2`; this is documentation
validation, not new FS acceptance evidence:

- `nix develop -c just check` — exit 0: locked dependencies, generated lock match
  and deliberate drift-negative probe, formatting, strict TypeScript,
  **105 tests / 1232 assertions**. Assertion counts vary with asynchronous polling;
  the historical 1251-assertion result above is preserved, not overwritten.
- `nix develop -c just ci-verify` — exit 0; pinned TypeScript/test derivation.
- `nix run .#sdlc -- install --check` — exit 0: adapters match the locked contract.
- `nix develop -c just ci-check` — exit 1 at the existing `sandboxImageGate`:
  `PASS IMAGE-CONTENT: 5 OCI layers and closure include OpenCode 2.0.32, Git, and the configured non-root entrypoint`,
  then `BLOCKED/INCOMPATIBLE`: no pre-provision contract guarantees the closure
  before the main Sandbox mount overlays `/nix/store`; an empty-volume overlay
  hides the baked executable. This is the retained compatibility failure, not a
  migration regression. No Sandbox or signature/authz negative is weakened.
- Read-only conservation audit against `git show 128b5f2:docs/<former-file>.md`:
  all 15 complete FS sections (including Required evidence) byte-identical;
  all 15 ledger ID/status cells identical; 172 unchanged normalized paragraphs/
  table rows across the five sources, with 13 explicitly reviewed navigation,
  document-ownership or superseded handoff-metadata paragraphs. Every original
  code-span command, evidence path, ID and failure retained except four replaced
  former-document navigation paths. The full prepared live runbook is retained.
  The 13 changed paragraphs preserve the original substantive statements; only
  links/section ownership and the now-authorized documentation migration differ.
- Audit commands (temporary read-only tools, outside the repository):

  ```sh
  nix shell --impure --expr '(let f = builtins.getFlake (toString ./.); in (f.inputs.sdlc.lib.importPackages { system = "x86_64-linux"; }).latest.python3)' -c python3 /tmp/opencode/verify-anvil-doc-migration.py
  nix shell --impure --expr '(let f = builtins.getFlake (toString ./.); in (f.inputs.sdlc.lib.importPackages { system = "x86_64-linux"; }).latest.python3)' -c python3 /tmp/opencode/verify-anvil-doc-site.py
  ```

  Both exit 0. The first compares original paragraphs, exact FS sections,
  statuses and code-span evidence, then checks Markdown/HTML/site paths and
  anchors (**89 links, zero broken** on the final documentation tree). The
  second starts pinned `nix run .#docs -- --root docs --project . --host 127.0.0.1 --port 0`,
  fetches every Markdown page and both prototype screens, resolves local rendered
  links/assets and validates explicit/heading fragments against the pinned
  Fieldnotes algorithm: **25 document/directory routes, 380 local rendered
  links/assets, 60 fragments**, all pass. Existing UI application hash routes are
  checked as routes rather than mistaken for missing DOM IDs. It terminates the
  local server on completion. Neither audit is browser/visual acceptance.
- The temporary audit launch first tried `python` and `python3`; both exited 127
  because no host interpreter is installed. It then used Python from the existing
  locked Nixpkgs input with the command above. Initial audit assertions exposed
  audit-harness issues (table paragraphs needed row-wise comparison and one old
  navigation path needed explicit accounting), not lost evidence. Four apparent
  `ui.html` anchor failures were existing application hash routes; source review
  confirmed their `parseHash`/`hashchange` handling. The final audits pass.
- After staging all new documents (so Nix includes them), replayed `ci-verify`
  and SDLC install check: both exit 0. Replayed `ci-check`: exit 1 at the same
  unchanged Sandbox gate. Source, tests, locks, package declarations and screens
  have no changes. `git diff --cached --check` passed.
- Unexpected navigation findings resolved: Fieldnotes confines serving to `docs/`
  and directories require `index.md`. Small active/completed navigation indexes
  now resolve; root `PLANS.md` links from served docs use the successor's public
  repository path. Former public documents are five-line navigation pointers,
  not duplicate contracts. No unresolved internal broken links remain.

This documentation checkpoint does not establish `LOCAL_SLICE_READY`.
Next controller turns should pursue the engineering milestones above and maintain
this plan rather than repeat documentation migrations.

<a id="governed-assignment-steering"></a>
## Governed Assignment steering checkpoint — 2026-10-30

**Implemented locally; checkpoint for independent controller review.** Baseline reconciled clean with
draft PR #124 at `b0ef495bd8d601ed58d7f087dd7f2e02feaee807`; predecessor PR #123
`f6723b79d5a938a86c6770660969a1298abde148` remains preserved. Operator authorized
one bounded engineering checkpoint for FS-03/04/08/11/12; FS criteria and statuses
remain unchanged. No live provider, cluster, dotfiles, merge/release or cutover
actions are authorized. FS-15 is `BLOCKED_EXTERNAL` and
K8S_ACCEPTANCE_REQUEST is `NOT_EXECUTABLE`.

### Design decisions and concrete progress

- `src/domain.ts` admits a typed, approved `steer` intent against the existing
  active Assignment/Attempt and its durably recorded Session, exact Commission
  version/specification generation, current controller Lease and remaining budget.
  It reserves one instruction and advances its sequence without changing scope,
  policy, evidence or Attempt identity. Immutable actor/request metadata lives on
  the Operation; there is no second mutation journal or unjournaled prompt path.
- The existing Operation table gains `steer` and immutable JSON request metadata
  via ordered migration `0006_assignment_steering.sql`. SQLite CAS, original
  Operation identity/owner, prepared/submitted/ambiguous/observed outcomes and
  message-ID reobservation remain authoritative. A single pending intent is the
  bounded contract: distinct requests are rejected while any Operation is
  unresolved, while identical retries return the original record. Conflicting
  reuse of a key fails; worker JSON cannot inject acceptance/specification fields.
- `ApplicationService.steerAssignment` is the one HTTP/MCP authorization path.
  It journals only; reconciliation dispatches after a fresh bound-Session idle
  observation. A running turn remains deferred even if it reports `safeBoundary`;
  steering never interrupts an active tool. Submission CAS arbitrates concurrent
  requests/autonomous observation, and Lease authority is rechecked around I/O.
- `ProviderComposition` and `OpenCodeAdapter` dispatch/inspect steering through
  the existing instruction/message-ID protocol. They verify the exact Session,
  bypass pending-steering execution caches, invalidate snapshots on prompts and
  journal-version changes, and recheck active state and application authority
  before model selection and prompt submission. This also prevents another
  composition instance from using pre-steer idle cache to authorize Continue.
- HTTP `POST /api/commissions/:id/steer`, MCP `steer_assignment`, and authenticated
  `steeringCommands` projections expose the same durable intent/audit/disposition.
  Ledger Overview provides the active Assignment form, version/generation,
  in-memory retry key, visible typed rejection and durable actor/time/target/status.
  A dropped HTTP response can be retried with the identical key; no automatic
  silent rebase/resubmission occurs after stale generation/CAS errors. Ledger
  styling and both prototype screens are retained. Stable interface/procedures
  are maintained in `docs/operations.md#governed-assignment-steering`.

### Findings and bounded limitations

- Found that the prior five-second execution cache could retain an idle snapshot
  across a newly accepted prompt. Cleared on prompt dispatch and refreshed on
  journal-version changes, including another composition instance's dispatch.
- Found that outcome recording against the pre-dispatch Commission version lost
  a known rejection when a hold arrived during model I/O. Recording now reloads
  current state and the original journal row under current Lease/CAS; the hold is
  preserved and the rejected intent remains inspectable. This does not fence a
  prompt already accepted by an external provider.
- If authority expires after submission and no message can be observed, the
  original submitted identity stays unresolved: absence is not safe retry proof.
  Invalidated prepared intents (amendment, deadline/budget, inactive Assignment)
  fail closed. Governed cancellation/replacement remains an open recovery gap.
- Accepted commands have durable attribution and provider disposition; rejected
  admissions do not create an audit record. This is one authenticated configured
  operator identity, not a new multi-principal identity/role system. Generalized
  command audit, browser/screenshot/accessibility review, actual Kubernetes Lease,
  exclusive Workspace/verifier isolation, and live OpenCode compatibility remain
  unverified. No whole FS obligation is promoted.

### Executed verification and outcome

- Initial `nix develop -c just typecheck` exited 2 because FakeWorld's exhaustive
  Operation switch lacked `steer`; added the explicit fixture case. A subsequent
  typecheck caught an optional audit-value assertion in the test, corrected with
  its known admitted fixture value. No application failure was hidden.
- `nix develop -c just fmt` and `nix develop -c just typecheck` — exit 0.
- `nix develop -c bun test test/steering.test.ts test/steering-protocol.test.ts test/ui.test.tsx`
  — exit 0: **16 tests / 209 assertions**. The 12 steering tests cover pure
  scope/budget/identity invariants; running/stale/future/foreign-Session deferral;
  SQLite reopen and lost-ack inspection/unknown absence; two SQLite writers and
  identical/conflicting requests; steering during autonomous observation; held,
  wrong-actor/forged payload/stale version/generation rejection; final reserved
  instruction; deadline/Lease expiry; hold or new busy state during model I/O;
  and cross-composition cache invalidation. Two protocol tests use an actual
  loopback daemon HTTP server and MCP JSON-RPC with production provider composition
  over local OpenCode/Sandbox fixtures. Two React integration tests use the real
  authenticated Hono/ApplicationService/SQLite path, including dropped HTTP
  response, retry-key preservation, audit/outcome and stale-generation errors.
- Full first replay of `nix develop -c just check` — exit 0: **120 tests / 1371
  assertions**, locked dependency install, generated-lock match/drift-negative,
  formatting and strict TypeScript. `ci-verify`, SDLC install check and UI/daemon
  builds/process smoke also exited 0; `ci-check` exited 1 at the preserved Sandbox
  gate. Final review then removed the misleading “after restart” wording for a
  newly queued Operation's submission and allowed reuse of the Assignment's
  recorded Session across strategy Attempts (the steering Operation still binds
  the current Attempt). The pure test now covers this reuse explicitly. Added no
  permission to change Assignment, generation or Session identity.
- Final prescribed replay on staged implementation sources (all new files
  included by Nix):

  | Exact command | Exit | Exact result / scope |
  |---|---|---|
  | `nix develop -c just check` | 0 | Locked install, deliberate lock-drift negative, formatting, strict TypeScript; **120 tests / 1372 assertions**, 21 files. |
  | `nix develop -c just ci-verify` | 0 | Pinned full TypeScript/test derivation `/nix/store/vchhmnzgb3144ciw25msixvalrxg1wyg-anvil-typescript-check-0.1.0.drv`. |
  | `nix run .#sdlc -- install --check` | 0 | `SDLC adapters match the locked contract`; fragment `.changes/assignment-steering.json` included. |
  | `nix develop -c just ci-check` | 1 | Retained `sandboxImageGate` failure; no check disabled or marked green. |
  | `nix build .#ui .#daemon .#checks.x86_64-linux.daemonSmoke --no-link -L` | 0 | UI 155 modules, embedded assets; non-root packaged daemon smoke verifies built UI/assets, auth, health/readiness, SQLite **schema v6**, SIGTERM and restart. |

  Current inspected outputs were
  `/nix/store/w52nczsacddpqhy09qnjwjwdpfwhyazg-anvil-ui-0.1.0` and
  `/nix/store/a6r5b233vkwnfyb4yscccv9cm6yipazj-anvil-daemon-0.1.0`;
  source/document changes can change input-addressed output paths. The final
  local proof source snapshot was
  `/nix/store/g8gnm54qzxkgpc9yzfaywimrxh0bgh9g-z5ya21hq1xa5zpa6c6zhv9r3agqq7hi0-source`.

  The failing gate printed:

  ```text
  PASS IMAGE-CONTENT: 5 OCI layers and closure include OpenCode 2.0.32, Git, and the configured non-root entrypoint
  BLOCKED/INCOMPATIBLE: the preflight rejects missing 9ysv2ynpka84idp745mcd8l0ayc2f102-opencode-2.0.32 paths, but no pre-provision contract guarantees the required closure is present; the main Sandbox mount overlays /nix/store and an empty-volume overlay hides the baked executable
  ```

- Tests demonstrate explicit provider POST counts and persisted journal/audit,
  not only Decisions. Running/deferred and unauthorized/rejected paths submit
  zero prompts; admitted idle steering and its concurrent/identical retries
  produce exactly one. Lost-ack/restart inspection retains that one prompt and
  original message ID; hidden/absent messages never produce a second submission.
  Concluded rejection is covered in the pure domain; whole-process kill failpoints
  and randomized steering/controller takeover schedules are not newly tested.
  The steering-specific HTTP/MCP tests run Hono through a real loopback Bun HTTP
  server, with explicit reconcile calls; they are not a new configured child-daemon
  steering/process-kill acceptance trace. Existing child-daemon lifecycle tests
  and packaged startup/restart smoke still pass.
- Final read-only Bun assertion against `git show b0ef495:docs/plans/active/autonomous-first-slice.md`
  compared all 15 complete `### FS-xx` sections and all 15 ID/status cells with the
  working plan: exit 0, byte-identical criteria/statuses and unchanged
  NOT_EXECUTABLE deployment gate. `git diff --exit-code HEAD -- scripts/check-sandbox-worker-image.ts scripts/prove-sandbox-worker-store-signatures.ts`
  exited 0 (the failing compatibility/security proofs are unchanged).
  `git diff --check` and `git diff --cached --check` exited 0.

This completes the requested bounded local implementation checkpoint, not
`LOCAL_SLICE_READY` or independent acceptance. FS-03/04/08/11/12 gain steering
evidence; every whole-FS status is retained. Acceptance evidence remains local
fixtures/components and deterministic SQLite recovery, not live provider or
browser acceptance. FS-15 remains `BLOCKED_EXTERNAL` and
K8S_ACCEPTANCE_REQUEST remains `NOT_EXECUTABLE`. Sandbox image compatibility and
the untrusted Nix protocol/derivation-add findings remain failed/open.

Next action: independent controller review of this checkpoint and its fail-closed
residuals, then separately steer the remaining local core work. Broader Campaign,
Findings/review, provider bootstrap/Lease/Workspace, generalized command audit,
governed invalidated-intent resolution and browser acceptance remain the gaps
listed above; this checkpoint does not begin another implementation milestone.
