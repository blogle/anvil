# Local daemon

The Bun daemon runs SQLite migrations, serves the authenticated HTTP/MCP
application surface, and scans durable active Commissions on a bounded interval.
Its current executable wiring deliberately reports provider observation as
unavailable; no fake provider is presented as a live integration. Injected
provider ports are used by local HTTP/MCP and scheduler tests.

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
readiness. Other HTTP and MCP requests require `Authorization: Bearer $ANVIL_API_TOKEN`.

## HTTP surface

- `GET /api/commissions` and `GET /api/commissions/:id`
- `GET /api/commissions/:id/operations`
- `POST /api/commissions` (typed proposal)
- `POST /api/commissions/:id/admit`
- `POST /api/commissions/:id/hold` with `{ "reason": "..." }`
- `POST /api/commissions/:id/resume`
- `POST /api/commissions/:id/amend` with expected generation and typed criteria
- `POST /api/commissions/:id/reconcile`
- Streamable MCP at `/mcp`: `list_commissions`, `get_commission`,
  `admit_commission`, `hold_commission`, and `resume_commission` use the same
  `ApplicationService` commands and SQLite projections as HTTP.

This is a local application checkpoint, not a complete FS-11 surface: Campaign,
Assignment, Findings, steer, and full history projections/tools remain gaps. MCP
session state is process-local and clients must reinitialize after daemon restart.
