# Anvil — Operations

This runbook describes operating the current daemon and its interfaces. Product
requirements are in [specification](spec.md) and [architecture](architecture.md).
Campaign execution status, acceptance evidence and authorization are maintained
in [active plans](plans/active/), including the [autonomous development plan](plans/active/autonomous-first-slice.md).

## Local daemon

The Bun daemon runs SQLite migrations, serves the authenticated HTTP/MCP
application surface, and scans durable active Commissions on a bounded interval.
The default reconciliation interval is 5 seconds (`ANVIL_RECONCILE_INTERVAL_MS`
accepts 250–60000 ms); OpenCode V2 execution events can wake the affected
Commission earlier. Session watchdog observations are cached for at most 5s.
It defaults to the explicit unavailable provider. An opt-in configured mode
composes Agent Sandbox, OpenCode V2, GitHub App/REST, and Mergify clients; exact
settings and provider limits are documented in
[`provider-contracts/runtime-configuration.md`](provider-contracts/runtime-configuration.md).
The configured mode includes namespaced Kubernetes Lease arbitration tested
against loopback protocol fixtures. It has not been deployed or accepted for
live multi-controller storage, Workspace exclusion or provider integration.

## Run

From the repository root, inside `nix develop`:

```sh
export ANVIL_API_TOKEN='<locally generated bearer token of at least 32 characters>'
export ANVIL_DATABASE='./anvil-local.sqlite'
export PORT=8080
bun run start
```

The database file is local application state and should not be committed. The
default unavailable-provider controller is single-process/local only. Configured
mode requires the explicit Kubernetes Lease settings below and never falls back
to that local authority. The operator identity defaults to
`local-operator`, and admission/amendment authorization is scoped to that
configured identity and the bearer credential. The current unavailable provider
means active work remains waiting/unavailable until an adapter is configured.

Unauthenticated `GET /healthz` and `GET /readyz` expose process and migration
readiness. API and MCP requests require `Authorization: Bearer $ANVIL_API_TOKEN`.
The optional static UI shell has no operational data until it authenticates.

## Operational Ledger UI

`nix build .#daemon .#ui` builds the actual Vite/React UI and daemon. The packaged
`anvil-daemon` serves its embedded UI at `/` on the same port as the API. It uses
TanStack Router/Query, Tailwind Ledger tokens and the shadcn composable Button
pattern. Enter the operator token in the Connect form; it remains in memory and
is cleared on disconnect/reload. No token is embedded in built assets or URLs.

For source development, run `bun run ui:dev` in a second Nix shell; its loopback
Vite server proxies `/api` to `127.0.0.1:8080`. Alternatively:

```sh
bun run ui:build
ANVIL_UI_DIRECTORY="$PWD/dist/ui" bun run start
```

Inbox search/repository/status filters and Commission inspection use real daemon
data. Inspector tabs expose Overview, Obligations, Operations, Finding references,
Activity and Attempts. Hold/resume and specification amendment use the existing
authorized application commands. Campaigns currently group registered Campaign
IDs; they do not invent Campaign specifications or dependency graphs. Operations
does not report invented fleet, performance or cost telemetry. Assignment steering
is available in the selected Commission's Overview. External OpenCode/preview
links remain unavailable. The read-only detail view
includes raw provider and Operation records to preserve inspectable provenance.
Browser screenshot review remains unperformed; the active plan tracks acceptance.

`test/ui.test.tsx` exercises component interaction against the actual in-process
authenticated daemon and SQLite. `checks.x86_64-linux.daemonSmoke` starts the
Nix-built non-root process and checks built HTML/assets, security headers, API
auth, migrations, persistence and restart; it is not a browser rendering test.

## HTTP surface

- `GET /api/commissions` and `GET /api/commissions/:id`
- `GET /api/commissions/:id/operations`
- `GET /api/commissions/:id/projection` (durable observations, execution freshness,
  evidence, domain-computed gaps, pending Operations and attempts)
- `GET /api/commissions/:id/history?before=<sequence>` (up to 100 decisions/errors,
  newest first; use the oldest returned sequence for the next page)
- `POST /api/commissions` (typed proposal)
- `POST /api/commissions/:id/admit`
- `POST /api/commissions/:id/hold` with `{ "reason": "..." }`
- `POST /api/commissions/:id/resume`
- `POST /api/commissions/:id/amend` with expected generation and typed criteria
- `POST /api/commissions/:id/reconcile`
- `POST /api/commissions/:id/steer` (governed Assignment instruction; see below)
- Streamable MCP at `/mcp`: `list_commissions`, `get_commission`,
  `admit_commission`, `hold_commission`, and `resume_commission` use the same
  `ApplicationService` commands and SQLite projections as HTTP.
- MCP `get_commission_projection` and `get_history` return the same projections
  as HTTP, with an optional positive integer `before` history cursor.
- MCP `steer_assignment` accepts `commissionId` plus the same steering request
  fields as HTTP and uses the same ApplicationService authorization path.

Schema v5 stores the latest reconciliation record and a changed-decision/error
history separately from Commission state and the single authoritative Operation
journal. Fresh provider polls may update observation timestamps but do not bump
Commission versions or append unchanged decision history. Late results cannot
overwrite newer versions or newer recorded times. These are post-reconciliation
read models: a crash between the authoritative commit and projection recording
can leave the projection missing/superseded until the next reconcile. They are
never consumed as acceptance authority or used to dispatch effects.

Broader Campaign/Assignment commands, full typed Findings and generalized command
audit remain gaps. Accepted steering commands have durable attribution in the
Operation journal; rejected admission attempts do not create journal records. MCP
session state is process-local and clients must reinitialize after daemon restart.

## Governed Assignment steering

Read the authenticated Commission projection to obtain its current state version,
specification generation and active Assignment. HTTP accepts a strict request:

```json
{
  "idempotencyKey": "operator-request-unique-key",
  "assignmentId": "existing-active-assignment-id",
  "expectedVersion": 7,
  "expectedGeneration": 1,
  "instruction": "Inspect the retry boundary within the approved implementation scope."
}
```

Keys contain 1–128 ASCII letters, digits, `_`, `.`, `:` or `-`; instructions are
nonblank and at most 8000 characters. The server derives actor identity from its
authenticated operator configuration, never from request JSON. It requires
ApplicationService approval for `steer`, a current controller Lease, exact
version/generation, active Assignment and recorded Session, active Commission and
remaining instruction/cost/deadline budget. The command cannot amend policy,
scope, repository, integration target, obligations or acceptance evidence.

Admission atomically records one prepared `steer` Operation and immutable
actor/time/target/request metadata with Commission CAS, reserving one instruction.
That reservation remains consumed even if later submission is rejected; this
interface adds no refund or cancellation mechanism. A Session recorded for the
same Assignment and generation can be reused across strategy Attempts, while the
steering Operation binds the current active Attempt.
HTTP returns 202 with that Operation; MCP returns the ApplicationService result.
The request performs no provider dispatch. Identical retries under the same
Commission/key return the original record without another reservation, even when
its expected version has since advanced. Reusing a key with different fields is
an `idempotency_conflict`. A distinct request is rejected while any Operation is
unresolved; this interface is a single pending intent, not a multi-command queue.

The reconciler defers prepared steering while the bound Session is running,
unknown or stale. Only a fresh idle observation permits submission; a running
turn's `safeBoundary` does not permit steering or interruption. The production
OpenCode adapter rechecks active-session state and application authority before
model selection and again before the prompt. If that boundary changes during I/O,
the prompt is not sent and the intent fails closed. Session target, Attempt,
generation, budget and Lease are revalidated. Autonomous dispatch sees the same
journal/CAS, and journal-version changes invalidate execution caches across
composition instances.

Inspect `steeringCommands` in HTTP/MCP projections or the Ledger's Steering audit
and status section. `prepared` is pending, not executed; `submitted`/`ambiguous`
requires remote observation. `observed/applied` proves the prompt's provider
identity was accepted/observed, not that its requested work or acceptance criteria
are complete. The projection retains actor, request time, Assignment, Session
target, idempotency key, exact request and provider disposition. `/history` remains
the separate derived reconciliation-decision/error view.

After a lost HTTP response, retry the identical request/key; the Ledger retains
it in memory across retries. After reload, inspect durable audit before creating
a new request. After a lost OpenCode acknowledgement, reconciliation inspects the
original message ID and never blindly replays it. An absent message is not safe
retry proof. If Lease loss leaves a submitted Operation with no observable effect,
it remains unresolved pending evidence or a future governed resolution contract.
Invalidated prepared intent likewise fails closed; this slice adds no cancellation
or replacement command. Hold/resume does not waive its generation or budget checks.

Schema v6 adds steering to the existing Operation table and preserves its existing
rows/findings. Back up SQLite before upgrading; a pre-v6 binary cannot reopen v6
state. Local fixtures validate this path; live OpenCode/Lease/Workspace isolation
and browser/visual acceptance remain separate evidence gates.

## Packaging and runtime prerequisites

Use the locked Nix tooling and Bun dependencies from a clean checkout:

```sh
nix develop -c just check
nix develop -c just ci-check
nix develop -c just ci-verify
nix run .#sdlc -- install --check
nix build .#ui .#daemon .#checks.x86_64-linux.daemonSmoke --no-link -L
```

These checks measure local behavior; consult the active plan for exact executed
results and known failures. A build or smoke test does not authorize deployment.
The packaged executable inherits its caller's UID and working directory. Keep
`ANVIL_DATABASE` on writable persistent storage (default `./anvil.sqlite`), with
a single writer and a defined backup/recovery strategy. Package code is read-only
in the Nix store. A read-only-rootfs runtime needs writable state mounts. OpenCode
needs writable HOME, XDG config/cache/data/state and TMPDIR, a configured HTTP
credential, and a reachable configured port (worker default 4096).

## Kubernetes Lease authority

Configured mode uses `coordination.k8s.io/v1` Leases through the production-intended
HTTP adapter. See [runtime configuration](provider-contracts/runtime-configuration.md)
for exact variables, timing, namespace/name mapping, CA/token and epoch contract.
Set an explicit controller label and Lease namespace, mount the Lease-specific
projected service-account token only into the controller, and supply the API CA
for HTTPS. Token content is reread for rotation and never logged or sent to a
worker. The configured label is not the full holder identity: each process adds
an incarnation UUID. Capabilities must use the actual durable Commission owner,
not a guessed controller label or a previous process's identity.

The proposed declarative permission boundary is one dedicated control namespace,
one controller-only ServiceAccount, and a Role/RoleBinding granting only:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: anvil-commission-leases
  namespace: APPROVED_CONTROL_NAMESPACE
rules:
  - apiGroups: [coordination.k8s.io]
    resources: [leases]
    verbs: [get, create, update]
```

An independently authorized deployment must declare the corresponding
ServiceAccount and namespaced RoleBinding (subject that controller ServiceAccount,
roleRef `Role/anvil-commission-leases`). Workers/verifiers receive no such token
or RoleBinding. No list/watch/delete, ClusterRole, Secret read, Pod exec or
cross-namespace access is needed by this adapter. Dynamic creation cannot be
restricted by `resourceNames`; dedicate the namespace to this trust boundary.
Holder strings and annotations are not cryptographic authorization against an
actor already allowed to rewrite these Leases. RBAC/token custody and the API's
CAS semantics are explicit trusted prerequisites. This YAML is a permission
contract only, not an applied manifest or deployment authorization.

Each authority check freshly reobserves and renews/acquires with resourceVersion
CAS; prior cached success is not a fallback during 401/403/409/429/5xx, timeout,
malformed/stale data or clock failure. After provider observation or model/status
I/O, authority is checked again before a new effect. OpenCode model/prompt and
interrupt/session writes, Sandbox create after lookup, and GitHub PR create after
lookup/credential I/O receive the same application authority callback. This can
stop a request before submission; it cannot fence an already accepted remote
write. Credential-provider token issuance during read/authentication remains the
existing broker contract, not a newly journaled Commission Operation.

Shutdown stops reconciliation and HTTP service, then attempts bounded CAS release
of known Leases before closing state. Release clears holder identity and retains
epoch history; it does not delete resources or terminate workers. Failed release
is reported and remaining contenders wait for conservatively observed expiry.
A hard exit likewise leaves expiry/reobservation to a successor. Successors
advance the epoch and inspect predecessor submitted/ambiguous Operations with
their original immutable owner and message/PR identity; a new holder never turns
unknown absence into retry permission.

Retain the shared authoritative SQLite state and Lease resources across restart.
A deleted Lease for a Commission with recorded ownership, regressed epoch,
int32 epoch exhaustion, state rollback or namespace migration fails closed and
requires explicit reviewed recovery. Clock synchronization must meet the
configured skew bound; a detected wall/monotonic jump latches failure until
restart. SQLite shared-storage topology and backup/restore remain separately
unverified deployment contracts; a fresh database is not a recovery substitute.

**Workspace isolation remains unverified.** A Lease arbitrates controller
instruction admission, not already-running worker filesystem access or an
independently credentialed OpenCode client. A successor adopts the healthy worker,
Workspace, Session and in-flight Operation; do not terminate it or revoke its
credentials merely because controller identity/epoch changed. Independently
exclude competing writers and use a separate verifier snapshot/checkout. The
active ExecPlan tracks campaign acceptance of this boundary.

### OpenCode API access boundary

Configured runtime requires `ANVIL_OPENCODE_PASSWORD_FILE` (at least 32 characters),
`ANVIL_OPENCODE_SECRET_NAME` and `ANVIL_OPENCODE_SECRET_KEY`. The controller reads
the file and sends Basic authentication as user `opencode`; the Sandbox references
the matching Secret as `OPENCODE_SERVER_PASSWORD`. The worker image also refuses
startup with a missing/short password. Password bytes are not in the Pod spec,
Operation journal or prompts. Non-loopback adapter transport requires HTTPS;
redirects are rejected. This protects against clients without the credential,
not clients that possess equivalent OpenCode authority.

The current image executes `opencode serve --hostname 0.0.0.0 --port 4096` by
default (host/port configurable). The Sandbox requests `service: true`, declares
that container port and disables automatic service-account token mounting. It
does not declare an ingress or NetworkPolicy. OpenCode's server and shell/tool
subprocesses run as the same non-root worker UID. **Pinned OpenCode 2.0.32 shell
subprocesses inherit the HTTP password and can read the server environment through
`/proc`; they can authenticate a second Session and raw Workspace write.** Basic
authentication and Kubernetes NetworkPolicy do not separate processes inside this
same container/Pod. A Secret reference does not hide environment values from tools.

`nix build .#checks.x86_64-linux.workerAccessGate --no-link -L` is a fail-closed
validation gate. It starts actual pinned OpenCode, checks missing/wrong-password
mutation denial, bootstraps a worker, then uses a real shell subprocess to attempt
credential recovery, Session creation and Workspace mutation. It currently fails
`BLOCKED/WORKER-API`, reporting booleans only. Do not waive the failure or treat a
passing bootstrap smoke as worker-authority isolation. Replacing this topology
requires a validated execution boundary that denies tool credential/process-memory
access and direct control-API access while retaining legitimate tool execution;
no compatible implementation is claimed here.

A separately authorized deployment must additionally prove controller-only TLS
ingress/service access, default-deny Sandbox ingress with only approved controller
sources permitted, no worker/preview route to control APIs, no shared credentials
with an independent client, and no worker/verifier RBAC for Secrets, Pod exec,
port-forward/proxy or Workspace volume mounting. Deny unreviewed privileged/host
access and mounts that bypass the boundary. Network policy must be enforced by
the actual CNI; it cannot fix the same-UID local failure above. Controller and
successor need the same recoverable per-worker authority without worker restart
or a Lease-epoch-triggered listener password rotation. Validate unauthorized
session/prompt/interrupt/fs/shell denial from worker and unrelated Pod identities,
not just from an external unauthenticated HTTP client, before deployment readiness.

### Worker Git receiver authorization

Worker capabilities are Assignment/Attempt/Session/Workspace/repository/ref scoped
and expire within 300 seconds. The credential endpoint rechecks current authority
before returning a GitHub installation token. The broker requests only the named
repository and `contents:write`, rejects missing/downgraded/extra permissions
(implicit `metadata:read` is allowed), and verifies the resulting token using
`GET /installation/repositories?per_page=2`: exactly one matching owner/name,
`total_count: 1`, no pagination or redirect. This proves local protocol handling;
live GitHub response/installation behavior remains separately unverified.

An extracted token is usable directly until its provider `expires_at`; capability
expiry, hold or controller succession does not revoke an already extracted token.
The helper cannot enforce its target ref on that direct use. Before a
single-Commission deployment can be accepted, the authoritative GitHub receiver
must deny creation, update and deletion of every branch except the exact approved
worker ref, and deny unauthorized tags. Branch/organization rulesets must be active
and cover existing **and newly created** refs; protecting only `main` is insufficient.
The worker App must have no direct or inherited ruleset/bypass authority, including
an App identity shared with a privileged controller. An integration actor's needed
bypass cannot be shared with worker tokens. A shared App is acceptable only if
this actual actor-policy interaction is independently demonstrated safe.

The authorized receiver validation must use the real proposed worker token/profile:
push the intended Candidate and compare the exact observed SHA; attempt a different
repository, target/main ref, another Commission ref, new branch, tag, deletion and
mixed allowed/forbidden multi-ref update. Require denial/no forbidden ref change,
including direct-token use without the Anvil helper. Record ruleset IDs, active
enforcement, ref patterns, App/installation IDs, effective bypass actors and token
expiry without recording token values. Test allowed work-branch rewriting only
according to the approved policy. Local `git-http-backend` pre-receive fixtures
demonstrate receiver behavior, not GitHub ruleset compatibility. If the chosen
GitHub installation/policy cannot express or enforce this boundary, deployment
readiness remains blocked pending an explicit reviewed decision; instructions
alone cannot satisfy it.

## Deployment and recovery procedure

Deployment requires an independently authorized declarative dotfiles workflow.
Before applying a change, record its approved scope, resource/namespace inventory,
immutable image digests, compatible agent-sandbox/OpenCode revisions, Secret
names/keys (never values), service accounts/RBAC, network/ingress authentication,
Workspace/state persistence, probes/ports and cleanup/rollback window. Confirm
that unrelated production resources are excluded. An ambiguous target, unbounded
credential or unreviewed image/secret stops execution.

Verify process and migration readiness, authenticated API/MCP and actual UI
assets. Check Workspace recoverability and one-writer ownership before restarting
or replacing a worker. On controller restart or succession, reobserve unresolved
Operations and provider-owned IDs before admitting further instructions; do not
replay ambiguous effects. Preserve logical Operation IDs, original owner,
specification generation, Candidate/PR/check identities, dispatch counts and
outcomes in redacted diagnostics. Clients must reinitialize volatile MCP sessions.

Shared-Nix readiness requires exclusive daemon store/database ownership, complete
closure registration and mounted-byte integrity before worker startup, approved
socket/build authorization, init ordering and GC roots. A read-only mount does
not make Unix-socket protocol requests read-only, and signature verification is
not protocol authorization. Do not infer readiness from path existence alone.

Capture failures, usage sources, before/after resource inventories and cleanup
results. Remove only the authorized resources through the declarative workflow.
The campaign-specific deployment gate, failure-injection timeline, evidence
packet and independent authorization remain in its [active plan](plans/active/autonomous-first-slice.md#live-acceptance).
