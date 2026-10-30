# Local daemon

The Bun daemon runs SQLite migrations, serves the authenticated HTTP/MCP
application surface, and scans durable active Commissions on a bounded interval.
The default reconciliation interval is 5 seconds (`ANVIL_RECONCILE_INTERVAL_MS`
accepts 250–60000 ms); OpenCode V2 execution events can wake the affected
Commission earlier. Session watchdog observations are cached for at most 5s.
It defaults to the explicit unavailable provider. An opt-in configured mode
composes Agent Sandbox, OpenCode V2, GitHub App/REST, and Mergify clients; exact
settings and provider limits are documented in
[`provider-contracts/runtime-configuration.md`](provider-contracts/runtime-configuration.md).
The configured mode is fixture-tested but has not been deployed, validated for
multi-controller operation, or accepted as a live provider integration.

## Run

From the repository root, inside `nix develop`:

```sh
export ANVIL_API_TOKEN='<locally generated bearer token of at least 32 characters>'
export ANVIL_DATABASE='./anvil-local.sqlite'
export PORT=8080
bun run start
```

The database file is local application state and should not be committed. The
default controller is single-process/local only; it is not a Kubernetes Lease
implementation or HA/fencing contract. The operator identity defaults to
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
does not report invented fleet, performance or cost telemetry. Steering and
external OpenCode/preview links remain unavailable. The read-only detail view
includes raw provider and Operation records to preserve inspectable provenance.
No full FS-12 acceptance or browser screenshot review is claimed.

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
- Streamable MCP at `/mcp`: `list_commissions`, `get_commission`,
  `admit_commission`, `hold_commission`, and `resume_commission` use the same
  `ApplicationService` commands and SQLite projections as HTTP.
- MCP `get_commission_projection` and `get_history` return the same projections
  as HTTP, with an optional positive integer `before` history cursor.

Schema v5 stores the latest reconciliation record and a changed-decision/error
history separately from Commission state and the single authoritative Operation
journal. Fresh provider polls may update observation timestamps but do not bump
Commission versions or append unchanged decision history. Late results cannot
overwrite newer versions or newer recorded times. These are post-reconciliation
read models: a crash between the authoritative commit and projection recording
can leave the projection missing/superseded until the next reconcile. They are
never consumed as acceptance authority or used to dispatch effects.

This is a local application checkpoint, not a complete FS-11 surface: Campaign,
Assignment commands, full typed Findings, steer, and command audit history remain gaps. MCP
session state is process-local and clients must reinitialize after daemon restart.
